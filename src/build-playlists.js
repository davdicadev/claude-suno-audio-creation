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
    if (pool.length < needed) {
      log.warn(
        `[${nome}] cartella ${etichetta}: anche con la riserva C mancano ` +
          `${needed - pool.length} brani. Le playlist saranno piu corte.`
      );
    }
  }

  const playlists = [];
  let idx = 0;
  for (let p = 0; p < numPlaylists; p++) {
    const brani = [];
    for (let k = 0; k < perPlaylist && idx < pool.length; k++) {
      brani.push(pool[idx++]);
    }
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

/** Monta una playlist in un MP3 unico con il concat demuxer di FFMPEG. */
function concatPlaylist(ffmpeg, brani, outFile, reencode) {
  const listFile = outFile + ".txt";
  const lines = brani.map((t) => {
    // Il concat demuxer vuole path con forward-slash; i nostri nomi sono ASCII
    // sicuri (nessun apostrofo), quindi niente escaping complicato.
    const p = t.abs.split(path.sep).join("/").replace(/'/g, "'\\''");
    return `file '${p}'`;
  });
  fs.writeFileSync(listFile, lines.join("\n") + "\n", "utf8");

  const codecArgs = reencode
    ? ["-c:a", "libmp3lame", "-b:a", "192k"]
    : ["-c", "copy"];
  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    ...codecArgs,
    outFile,
  ];
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  try {
    fs.unlinkSync(listFile);
  } catch (_) {}
  if (r.status !== 0) {
    throw new Error(
      `FFMPEG ha fallito (${outFile}). ` +
        (reencode ? "" : "Riprova con --reencode. ") +
        `stderr: ${String(r.stderr || "").slice(-500)}`
    );
  }
}

function writeTracklist(ffprobe, brani, outFile, totaleLabel) {
  let cursor = 0;
  const righe = [];
  for (const t of brani) {
    righe.push(`${formatTime(cursor)} - ${t.display}`);
    cursor += runFfprobeDuration(ffprobe, t.abs) || 0;
  }
  const header = totaleLabel
    ? `# ${totaleLabel}  (durata totale ${formatTime(cursor)}, ${brani.length} brani)\n\n`
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

  for (const job of jobs) {
    if (job.brani.length === 0) {
      log.warn(`[${project.nome}] ${job.name}: nessun brano, salto.`);
      continue;
    }
    const mp3 = path.join(project.dirs.export, `${job.name}.mp3`);
    const txt = path.join(project.dirs.tracklist, `${job.name}.txt`);
    log.info(`[${project.nome}] monto ${job.name} (${job.brani.length} brani)`);
    concatPlaylist(cfg.ffmpegPath, job.brani, mp3, reencode);
    writeTracklist(cfg.ffprobePath, job.brani, txt, job.name);
    log.info(`[${project.nome}]   -> ${mp3}`);
    log.info(`[${project.nome}]   -> ${txt}`);
  }
  log.step(`[${project.nome}] playlist e tracklist completate.`);
}

function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);

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
