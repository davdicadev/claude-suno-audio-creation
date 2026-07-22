"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG_PATH = path.resolve(
  process.cwd(),
  "config",
  "projects.json"
);

/**
 * Carica e valida il file di configurazione multi-progetto.
 * @param {string} [configPath]
 * @returns {object} config normalizzata
 */
function loadConfig(configPath) {
  const p = configPath || process.env.SUNO_CONFIG || DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(p)) {
    throw new Error(
      `File di configurazione non trovato: ${p}\n` +
        `Copia config/projects.example.json in config/projects.json e adattalo.`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Config JSON non valido (${p}): ${e.message}`);
  }

  if (!raw.baseDir) throw new Error("Config: manca 'baseDir'.");
  if (!Array.isArray(raw.progetti) || raw.progetti.length === 0) {
    throw new Error("Config: 'progetti' deve essere un array non vuoto.");
  }

  const maxBatchGlobal = int(raw.maxGenerazioniPerBatch, 10);

  const cfg = {
    baseDir: raw.baseDir,
    ffmpegPath: raw.ffmpegPath || "ffmpeg",
    ffprobePath: raw.ffprobePath || "ffprobe",
    sunoUrl: raw.sunoUrl || "https://suno.com",
    // Canale browser: "chrome" usa il Google Chrome installato (consigliato per
    // superare il blocco del login Google), "msedge" per Edge, "" per il
    // Chromium interno di Playwright.
    browserChannel:
      raw.browserChannel === undefined ? "chrome" : raw.browserChannel,
    // Cartella che contiene un profilo browser (= una sessione/account Suno)
    // per ogni nome profilo usato dai progetti.
    browserProfilesDir:
      raw.browserProfilesDir || path.join(raw.baseDir, "browser-profiles"),
    maxGenerazioniPerBatch: maxBatchGlobal,
    // Montaggio: di default ricodifica per avere tempi ESATTI (gli MP3 di Suno
    // hanno header di durata imprecisi che sfasano la tracklist). montaggioVeloce
    // usa la copia diretta (istantanea ma con tempi imprecisi).
    montaggioVeloce: raw.montaggioVeloce === true,
    // Taglio del silenzio in eccesso a inizio/fine di ogni brano.
    tagliaSilenzio: raw.tagliaSilenzio !== false, // default true
    maxSilenzioSecondi:
      typeof raw.maxSilenzioSecondi === "number" ? raw.maxSilenzioSecondi : 3,
    sogliaSilenzioDb:
      typeof raw.sogliaSilenzioDb === "number" ? raw.sogliaSilenzioDb : -50,
    configPath: p,
    progetti: raw.progetti.map((pr, i) =>
      normalizeProject(pr, i, raw.baseDir, maxBatchGlobal)
    ),
  };
  return cfg;
}

function normalizeProject(pr, index, baseDir, maxBatchGlobal) {
  if (!pr.nome) throw new Error(`Progetto #${index}: manca 'nome'.`);
  if (!Array.isArray(pr.prompts) || pr.prompts.length === 0) {
    throw new Error(`Progetto '${pr.nome}': 'prompts' vuoto.`);
  }
  const playlist = pr.playlist || {};
  const daA = int(playlist.daA, 0);
  const daB = int(playlist.daB, 0);
  const braniPerPlaylist = int(playlist.braniPerPlaylist, 0);
  if (braniPerPlaylist < 1) {
    throw new Error(
      `Progetto '${pr.nome}': 'playlist.braniPerPlaylist' deve essere >= 1.`
    );
  }
  if (daA + daB < 1) {
    throw new Error(
      `Progetto '${pr.nome}': 'daA' + 'daB' deve essere >= 1.`
    );
  }

  const dir = path.join(baseDir, pr.nome);
  const project = {
    nome: pr.nome,
    attivo: pr.attivo !== false,
    // Nome del profilo browser = account Suno. Progetti con lo stesso valore
    // condividono l'account; valori diversi usano account diversi.
    sunoProfilo: String(pr.sunoProfilo || "default").trim() || "default",
    maxGenerazioniPerBatch: int(pr.maxGenerazioniPerBatch, maxBatchGlobal),
    keywordsTitoli: Array.isArray(pr.keywordsTitoli) ? pr.keywordsTitoli : [],
    prompts: pr.prompts.map((x, j) => ({
      testo: String(x.testo || "").trim(),
      strumentale: x.strumentale === true,
      _idx: j,
    })),
    playlist: { daA, daB, braniPerPlaylist },
    margineGenerazione:
      typeof pr.margineGenerazione === "number" ? pr.margineGenerazione : 0.15,
    dirs: {
      root: dir,
      A: path.join(dir, "cartella-A"),
      B: path.join(dir, "cartella-B"),
      C: path.join(dir, "cartella-C"),
      export: path.join(dir, "export"),
      tracklist: path.join(dir, "tracklist"),
      manifest: path.join(dir, "manifest.json"),
    },
  };

  for (const p of project.prompts) {
    if (!p.testo) {
      throw new Error(`Progetto '${pr.nome}': un prompt ha 'testo' vuoto.`);
    }
  }

  // Suno elabora al massimo ~10 generazioni contemporaneamente: limita il lotto.
  project.maxGenerazioniPerBatch = Math.min(
    10,
    Math.max(1, project.maxGenerazioniPerBatch)
  );

  project.fabbisogno = computeGenerationNeeds(project);
  return project;
}

/**
 * Calcola quanti brani servono per cartella e quanti "click" di generazione
 * lanciare su Suno.
 *
 * Regole:
 *  - servono (daA * N) brani in A e (daB * N) brani in B
 *  - ogni click Suno produce 2 brani: 1 va in A, 1 in B -> un click riempie
 *    contemporaneamente un posto in A e uno in B
 *  - i click base = max(bisognoA, bisognoB)
 *  - si aggiunge un margine (default 15%) per coprire coppie non formate:
 *    quei brani "spaiati" finiscono in C e servono a tappare i buchi.
 */
function computeGenerationNeeds(project) {
  const N = project.playlist.braniPerPlaylist;
  const bisognoA = project.playlist.daA * N;
  const bisognoB = project.playlist.daB * N;
  const clickBase = Math.max(bisognoA, bisognoB);
  const clickConMargine = Math.ceil(clickBase * (1 + project.margineGenerazione));

  // Distribuisce i click tra i prompt del progetto (round-robin).
  const perPrompt = distribute(clickConMargine, project.prompts.length);

  return {
    bisognoA,
    bisognoB,
    clickBase,
    clickTotali: clickConMargine,
    clickPerPrompt: perPrompt,
  };
}

function distribute(total, buckets) {
  const base = Math.floor(total / buckets);
  const resto = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < resto ? 1 : 0));
}

function int(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

module.exports = { loadConfig, computeGenerationNeeds, DEFAULT_CONFIG_PATH };
