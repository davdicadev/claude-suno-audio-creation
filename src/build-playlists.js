#!/usr/bin/env node
"use strict";

/**
 * Fase 3: creazione playlist + montaggio FFMPEG + tracklist.
 *
 * Per ogni progetto:
 *   - crea daA playlist pescando dalla cartella A e daB playlist dalla B;
 *   - se A o B non hanno abbastanza brani, riempie i buchi con la cartella C
 *     (C e una riserva condivisa: ogni brano di C viene usato una sola volta);
 *   - monta ogni playlist in un unico MP3 con FFMPEG, in ORDINE ALFABETICO
 *     (A -> Z) del nome file;
 *   - genera una tracklist .txt con titolo (versione display) e timestamp.
 *
 * Uso:
 *   node src/build-playlists.js
 *   node src/build-playlists.js --project canale-lofi
 *   node src/build-playlists.js --reencode   # ricodifica invece di -c copy
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfig } = require("./lib/config");
const manifestLib = require("./lib/manifest");
const { displayTitle } = require("./lib/sanitize");
const log = require("./lib/logger");

function parseArgs(argv) {
  const args = { project: null, config: null, reencode: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--reencode") args.reencode = true;
  }
  return args;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Tracce di una cartella (A/B/C) prese dal manifest, con percorso assoluto. */
function tracksInFolder(project, manifest, folder) {
  return (manifest.tracks || [])
    .filter((t) => t.folder === folder)
    .map((t) => ({
      ...t,
      abs: path.join(project.dirs.root, t.file.split("/").join(path.sep)),
      display: t.displayTitle || displayTitle(t.originalTitle || "Brano"),
    }))
    .filter((t) => fs.existsSync(t.abs));
}

/**
 * Costruisce l'elenco delle playlist da una cartella sorgente, riempiendo i
 * buchi con i brani della riserva C (consumati dal pool condiviso).
 * @returns {Array<Array<track>>} una lista di playlist (ognuna e un array di brani)
 */
function buildPlaylistsFromFolder(sourceTracks, cPool, numPlaylists, perPlaylist, nome, etichetta) {
  const needed = numPlaylists * perPlaylist;
  const pool = shuffle(sourceTracks);

  // Riempi con la riserva C se la sorgente non basta.
  if (pool.length < needed) {
    const mancanti = needed - pool.length;
    const fill = cPool.splice(0, mancanti); // consuma dalla riserva C
    pool.push(...fill);
    if (fill.length > 0) {
      log.info(
        `[${nome}] cartella ${etichetta}: ${sourceTracks.length} brani, ne servono ${needed}. ` +
          `Aggiunti ${fill.length} dalla riserva C.`
      );
    }
  }

  // REGOLA: ogni playlist DEVE avere ESATTAMENTE 'perPlaylist' brani. Creiamo
  // quindi solo playlist COMPLETE. Se il materiale non basta per tutte quelle
  // richieste, ne creiamo di meno (meglio poche playlist piene che tante
  // incomplete). I brani in eccesso (meno di una playlist intera) restano
  // inutilizzati per questa esecuzione.
  const completabili = Math.min(
    numPlaylists,
    Math.floor(pool.length / perPlaylist)
  );
  if (completabili < numPlaylists) {
    log.warn(
      `[${nome}] cartella ${etichetta}: con ${pool.length} brani disponibili posso ` +
        `creare ${completabili}/${numPlaylists} playlist da ${perPlaylist} brani. ` +
        "Le playlist mancanti NON vengono create (servono piu' brani): rilancia la " +
        "generazione o abbassa 'braniPerPlaylist'/'daA'/'daB'."
    );
  }

  const playlists = [];
  let idx = 0;
  for (let p = 0; p < completabili; p++) {
    const brani = pool.slice(idx, idx + perPlaylist);
    idx += perPlaylist;
    // Montaggio in ordine ALFABETICO del nome file.
    brani.sort((a, b) =>
      (a.safeFileName || path.basename(a.abs)).localeCompare(
        b.safeFileName || path.basename(b.abs),
        "en",
        { sensitivity: "base" }
      )
    );
    playlists.push(brani);
  }
  return playlists;
}

function runFfprobeDuration(ffprobe, file) {
  const r = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) return 0;
  const d = parseFloat(String(r.stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Analizza un brano decodificandolo: durata REALE (gli header MP3 di Suno sono
 * imprecisi) + silenzio a inizio/fine.
 * @returns {{real:number, leading:number, trailingStart:(number|null)}}
 */
function analyzeTrack(cfg, file) {
  const r = spawnSync(
    cfg.ffmpegPath,
    [
      "-hide_banner",
      "-i",
      file,
      "-af",
      `silencedetect=noise=${cfg.sogliaSilenzioDb}dB:d=0.5`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const err = String(r.stderr || "");

  // durata reale = ultimo "time=HH:MM:SS.ss" stampato dalla decodifica
  let real = 0;
  const tre = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let tm;
  let lastT = null;
  while ((tm = tre.exec(err))) lastT = tm;
  if (lastT) {
    real = Number(lastT[1]) * 3600 + Number(lastT[2]) * 60 + parseFloat(lastT[3]);
  }
  if (!real) real = runFfprobeDuration(cfg.ffprobePath, file); // fallback header

  // eventi di silenzio, in ordine
  const events = [];
  const sre = /silence_(start|end):\s*(-?[0-9.]+)/g;
  let sm;
  while ((sm = sre.exec(err))) events.push({ type: sm[1], t: parseFloat(sm[2]) });

  let leading = 0;
  if (events.length && events[0].type === "start" && events[0].t < 0.5) {
    const end = events.find((e, i) => i > 0 && e.type === "end");
    leading = end ? end.t : real; // se non trova la fine, il file e' tutto silenzio
  }

  let trailingStart = null;
  const last = events[events.length - 1];
  if (last) {
    if (last.type === "start") {
      trailingStart = last.t; // silenzio che arriva fino a fine file
    } else if (last.type === "end" && real && Math.abs(last.t - real) < 1.0) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "start") {
          trailingStart = events[i].t;
          break;
        }
      }
    }
  }
  return { real, leading, trailingStart };
}

// Quota MINIMA del brano da conservare dopo il taglio del silenzio. La musica
// molto silenziosa (fade-out, passaggi soft di neo-soul/bossa/lofi) viene spesso
// scambiata per "silenzio" da silencedetect: senza questo limite un brano di 3
// minuti verrebbe tagliato a pochi secondi. Se il taglio rimuoverebbe piu' di
// (1 - questa quota) del brano, e' quasi certamente un falso positivo e NON
// tagliamo. Il taglio di vero silenzio a inizio/fine resta sempre sotto questa
// soglia (di solito pochi secondi), quindi non viene mai bloccato.
const MIN_FRAZIONE_BRANO = 0.7;

/** Calcola i punti di taglio (inizio/fine) per lasciare max N secondi di silenzio. */
function computeCuts(cfg, a) {
  let startCut = 0;
  let endCut = a.real;
  if (cfg.tagliaSilenzio && a.real > 0) {
    if (a.leading > cfg.maxSilenzioSecondi) {
      startCut = a.leading - cfg.maxSilenzioSecondi;
    }
    if (a.trailingStart != null) {
      const trailing = a.real - a.trailingStart;
      if (trailing > cfg.maxSilenzioSecondi) {
        endCut = a.trailingStart + cfg.maxSilenzioSecondi;
      }
    }
  }
  if (endCut > a.real) endCut = a.real;
  if (startCut < 0) startCut = 0;

  const durTagliata = endCut - startCut;
  // Sicurezza anti-falso-positivo: se il taglio rimuove troppo (musica soft
  // scambiata per silenzio) o azzererebbe il brano, tieni il brano INTERO.
  if (a.real > 0 && durTagliata < a.real * MIN_FRAZIONE_BRANO) {
    return { startCut: 0, endCut: a.real, dur: a.real, sospetto: true };
  }
  if (durTagliata < 0.5) {
    return { startCut: 0, endCut: a.real, dur: a.real, sospetto: true };
  }
  return { startCut, endCut, dur: durTagliata, sospetto: false };
}

/**
 * Monta i segmenti (con inpoint/outpoint) RICODIFICANDO: cosi i tempi sono
 * esatti e il silenzio in eccesso viene tagliato in un unico passaggio.
 */
function concatAccurate(cfg, segments, outFile) {
  const listFile = outFile + ".txt";
  const lines = [];
  for (const s of segments) {
    const p = s.abs.split(path.sep).join("/").replace(/'/g, "'\\''");
    lines.push(`file '${p}'`);
    lines.push(`inpoint ${s.startCut.toFixed(3)}`);
    lines.push(`outpoint ${s.endCut.toFixed(3)}`);
  }
  fs.writeFileSync(listFile, lines.join("\n") + "\n", "utf8");
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    outFile,
  ];
  const r = spawnSync(cfg.ffmpegPath, args, { encoding: "utf8" });
  try {
    fs.unlinkSync(listFile);
  } catch (_) {}
  if (r.error || r.status !== 0) {
    const dett = r.error ? r.error.message : String(r.stderr || "").slice(-400);
    throw new Error(`FFMPEG concat fallito (${outFile}): ${dett}`);
  }
}

/** Montaggio veloce (copia diretta, tempi imprecisi) - solo se richiesto. */
function concatFast(cfg, brani, outFile) {
  const listFile = outFile + ".txt";
  const lines = brani.map((t) => {
    const p = t.abs.split(path.sep).join("/").replace(/'/g, "'\\''");
    return `file '${p}'`;
  });
  fs.writeFileSync(listFile, lines.join("\n") + "\n", "utf8");
  const r = spawnSync(
    cfg.ffmpegPath,
    ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile],
    { encoding: "utf8" }
  );
  try {
    fs.unlinkSync(listFile);
  } catch (_) {}
  if (r.error || r.status !== 0) {
    const dett = r.error ? r.error.message : String(r.stderr || "").slice(-400);
    throw new Error(`FFMPEG (veloce) fallito (${outFile}): ${dett}`);
  }
}

/** Scrive la tracklist usando le durate (gia' tagliate) dei segmenti. */
function writeTracklist(segments, outFile, totaleLabel) {
  let cursor = 0;
  const righe = [];
  for (const s of segments) {
    righe.push(`${formatTime(cursor)} - ${s.display}`);
    cursor += s.dur || 0;
  }
  const header = totaleLabel
    ? `# ${totaleLabel}  (durata totale ${formatTime(cursor)}, ${segments.length} brani)\n\n`
    : "";
  fs.writeFileSync(outFile, header + righe.join("\n") + "\n", "utf8");
}

function processProject(cfg, project, reencode) {
  const manifestPath = project.dirs.manifest;
  if (!fs.existsSync(manifestPath)) {
    log.warn(`[${project.nome}] manifest assente, salto.`);
    return;
  }
  const manifest = manifestLib.load(manifestPath);
  fs.mkdirSync(project.dirs.export, { recursive: true });
  fs.mkdirSync(project.dirs.tracklist, { recursive: true });

  const A = tracksInFolder(project, manifest, "A");
  const B = tracksInFolder(project, manifest, "B");
  const cPool = shuffle(tracksInFolder(project, manifest, "C"));

  const { daA, daB, braniPerPlaylist } = project.playlist;
  log.step(
    `[${project.nome}] costruisco ${daA} playlist da A e ${daB} da B ` +
      `(${braniPerPlaylist} brani ciascuna). Disponibili: A=${A.length} B=${B.length} C=${cPool.length}`
  );

  const playlistsA = buildPlaylistsFromFolder(
    A, cPool, daA, braniPerPlaylist, project.nome, "A"
  );
  const playlistsB = buildPlaylistsFromFolder(
    B, cPool, daB, braniPerPlaylist, project.nome, "B"
  );

  const jobs = [];
  playlistsA.forEach((brani, i) => jobs.push({ name: `playlist_A_${i + 1}`, brani }));
  playlistsB.forEach((brani, i) => jobs.push({ name: `playlist_B_${i + 1}`, brani }));

  const veloce = cfg.montaggioVeloce && !reencode;

  for (const job of jobs) {
    if (job.brani.length === 0) {
      log.warn(`[${project.nome}] ${job.name}: nessun brano, salto.`);
      continue;
    }
    const mp3 = path.join(project.dirs.export, `${job.name}.mp3`);
    const txt = path.join(project.dirs.tracklist, `${job.name}.txt`);

    if (veloce) {
      log.info(
        `[${project.nome}] monto ${job.name} (${job.brani.length} brani, modalita' veloce)`
      );
      const segs = job.brani.map((t) => ({
        display: t.display,
        dur: runFfprobeDuration(cfg.ffprobePath, t.abs) || 0,
      }));
      concatFast(cfg, job.brani, mp3);
      writeTracklist(segs, txt, job.name);
    } else {
      log.info(
        `[${project.nome}] monto ${job.name} (${job.brani.length} brani): ` +
          "analizzo durate e silenzio..."
      );
      const segments = [];
      let tagliati = 0;
      let sospetti = 0;
      for (const t of job.brani) {
        const a = analyzeTrack(cfg, t.abs);
        const cuts = computeCuts(cfg, a);
        if (cuts.sospetto) sospetti += 1;
        else if (cuts.startCut > 0.05 || cuts.endCut < a.real - 0.05) tagliati += 1;
        segments.push({
          abs: t.abs,
          display: t.display,
          startCut: cuts.startCut,
          endCut: cuts.endCut,
          dur: cuts.dur,
        });
      }
      log.info(
        `[${project.nome}]   ${job.name}: silenzio tagliato in ${tagliati}/${segments.length} brani` +
          (sospetti
            ? `; ${sospetti} brani tenuti INTERI (taglio sospetto, musica soft scambiata per silenzio)`
            : "") +
          ". Ricodifico..."
      );
      concatAccurate(cfg, segments, mp3);
      writeTracklist(segments, txt, job.name);
    }
    log.info(`[${project.nome}]   -> ${mp3}`);
    log.info(`[${project.nome}]   -> ${txt}`);
  }
  log.step(`[${project.nome}] playlist e tracklist completate.`);
}

// Verifica che ffmpeg/ffprobe siano davvero lanciabili. Da n8n avviato
// dall'interfaccia grafica (launchd) il PATH spesso NON contiene
// /opt/homebrew/bin, quindi "ffmpeg" non viene trovato e spawnSync fallisce
// con stderr vuoto. Qui diamo un messaggio chiaro e la soluzione.
function ensureFfmpeg(cfg) {
  for (const [nome, bin] of [
    ["ffmpeg", cfg.ffmpegPath],
    ["ffprobe", cfg.ffprobePath],
  ]) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      const motivo =
        r.error && r.error.code === "ENOENT"
          ? `'${bin}' non trovato nel PATH`
          : r.error
            ? r.error.message
            : `exit ${r.status}`;
      throw new Error(
        `${nome} non è utilizzabile (${motivo}).\n` +
          `Se lanci da n8n, l'ambiente spesso non vede /opt/homebrew/bin. Rimedi:\n` +
          `  1) avvia n8n da Terminale (eredita il PATH giusto), OPPURE\n` +
          `  2) metti il percorso COMPLETO nel config/projects.json:\n` +
          `       "ffmpegPath": "/opt/homebrew/bin/ffmpeg",\n` +
          `       "ffprobePath": "/opt/homebrew/bin/ffprobe"\n` +
          `     (verifica il percorso con 'which ffmpeg' nel Terminale).`
      );
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  ensureFfmpeg(cfg);

  let progetti = cfg.progetti.filter((p) => p.attivo);
  if (args.project) {
    progetti = progetti.filter((p) => p.nome === args.project);
    if (progetti.length === 0) {
      throw new Error(`Progetto '${args.project}' non trovato o non attivo.`);
    }
  }
  for (const project of progetti) processProject(cfg, project, args.reencode);
  log.step("Fase playlist/tracklist completata.");
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    log.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}

module.exports = { formatTime, buildPlaylistsFromFolder };
