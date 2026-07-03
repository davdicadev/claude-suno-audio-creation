#!/usr/bin/env node
"use strict";

/**
 * Fase 2: riscrittura dei titoli con le API di Claude.
 *
 * Per ogni brano scaricato genera un titolo UNICO ottimizzato sulle parole
 * chiave del progetto (per il video YouTube). Salva DUE versioni:
 *   - displayTitle: titolo "bello" (con eventuali caratteri speciali) usato
 *     nella tracklist;
 *   - safeFileName: nome file SICURO (solo ASCII) con cui il brano viene
 *     rinominato su disco, cosi FFMPEG e PowerShell non si rompono mai e
 *     l'ordine alfabetico del montaggio usa gia i titoli ottimizzati.
 *
 * Richiede la variabile d'ambiente ANTHROPIC_API_KEY.
 *
 * Uso:
 *   node src/rewrite-titles.js
 *   node src/rewrite-titles.js --project canale-lofi
 *   node src/rewrite-titles.js --model claude-haiku-4-5
 *   node src/rewrite-titles.js --dry-run     # non rinomina, mostra solo
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { loadConfig } = require("./lib/config");
const manifestLib = require("./lib/manifest");
const { safeFileBase, displayTitle, uniqueBase } = require("./lib/sanitize");
const log = require("./lib/logger");

const DEFAULT_MODEL = "claude-haiku-4-5";
const CHUNK = 25;

function parseArgs(argv) {
  const args = { project: null, config: null, model: DEFAULT_MODEL, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Chiede a Claude titoli ottimizzati per un gruppo di brani. */
async function generateTitles(client, model, keywords, items) {
  const system =
    "Sei un esperto di SEO per YouTube specializzato in musica di sottofondo " +
    "(lofi, ambient, relax, focus). Scrivi titoli di brani brevi, evocativi e " +
    "unici, ottimizzati per la ricerca, in inglese. Ogni titolo deve essere " +
    "diverso dagli altri, lungo 2-6 parole, senza numerazioni, senza virgolette " +
    "e senza emoji.";

  const lista = items
    .map((it, i) => `${i + 1}. ${it.originalTitle || "brano"}`)
    .join("\n");

  const user =
    `Parole chiave del canale: ${keywords.length ? keywords.join(", ") : "(nessuna)"}\n\n` +
    `Genera un titolo nuovo e unico per ognuno di questi ${items.length} brani, ` +
    `mantenendo lo stile del canale e incorporando naturalmente le parole chiave ` +
    `dove ha senso (non forzare tutte le keyword in ogni titolo).\n\n` +
    `Brani:\n${lista}\n\n` +
    `Rispondi SOLO con un array JSON, un elemento per brano nello stesso ordine, ` +
    `nel formato: [{"n": 1, "titolo": "..."}]. Nessun testo prima o dopo il JSON.`;

  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = parseJsonArray(text);
  if (!parsed || parsed.length === 0) {
    throw new Error("Risposta di Claude non interpretabile come array JSON.");
  }
  // Mappa n -> titolo
  const byN = new Map();
  for (const el of parsed) {
    const n = Number(el.n || el.index);
    const titolo = String(el.titolo || el.title || "").trim();
    if (Number.isFinite(n) && titolo) byN.set(n, titolo);
  }
  return items.map((_, i) => byN.get(i + 1) || items[i].originalTitle || "Brano");
}

function parseJsonArray(text) {
  if (!text) return null;
  // Estrae il primo blocco [ ... ] anche se circondato da testo.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

async function processProject(client, model, project, dryRun) {
  const manifestPath = project.dirs.manifest;
  if (!fs.existsSync(manifestPath)) {
    log.warn(`[${project.nome}] manifest assente (${manifestPath}), salto.`);
    return;
  }
  const manifest = manifestLib.load(manifestPath);
  const tracks = manifest.tracks || [];
  if (tracks.length === 0) {
    log.warn(`[${project.nome}] nessun brano nel manifest, salto.`);
    return;
  }

  log.step(`[${project.nome}] riscrivo ${tracks.length} titoli con ${model}`);

  // 1) Genera titoli a blocchi.
  const newTitles = [];
  for (const group of chunk(tracks, CHUNK)) {
    const titoli = await generateTitles(
      client,
      model,
      project.keywordsTitoli || manifest.keywordsTitoli || [],
      group
    );
    newTitles.push(...titoli);
  }

  // 2) Assegna displayTitle + nome file sicuro e univoco.
  const usedBases = new Set();
  let renamed = 0;
  let skipped = 0;
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    const disp = displayTitle(newTitles[i]);
    const base = uniqueBase(safeFileBase(disp), usedBases, tr.id);
    const newRel = path
      .join(`cartella-${tr.folder}`, `${base}.mp3`)
      .split(path.sep)
      .join("/");

    tr.displayTitle = disp;
    tr.safeFileName = `${base}.mp3`;

    const oldAbs = path.join(project.dirs.root, tr.file.split("/").join(path.sep));
    const newAbs = path.join(project.dirs.root, newRel.split("/").join(path.sep));

    if (tr.file === newRel) {
      skipped += 1;
    } else if (dryRun) {
      log.info(`[${project.nome}]   (dry-run) ${tr.file} -> ${newRel}  |  "${disp}"`);
    } else if (fs.existsSync(oldAbs)) {
      try {
        fs.renameSync(oldAbs, newAbs);
        tr.file = newRel;
        renamed += 1;
      } catch (e) {
        log.warn(`[${project.nome}]   rinomina fallita ${tr.file}: ${e.message}`);
      }
    } else {
      log.warn(`[${project.nome}]   file non trovato: ${oldAbs}`);
    }
  }

  if (!dryRun) {
    manifest.titlesRewrittenAt = new Date().toISOString();
    manifest.titleModel = model;
    manifestLib.save(manifestPath, manifest);
  }
  log.step(
    `[${project.nome}] titoli riscritti. Rinominati: ${renamed}, gia a posto: ${skipped}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Manca la variabile ANTHROPIC_API_KEY. Impostala con la tua chiave " +
        "creata su console.anthropic.com (vedi README)."
    );
  }
  const cfg = loadConfig(args.config);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let progetti = cfg.progetti.filter((p) => p.attivo);
  if (args.project) {
    progetti = progetti.filter((p) => p.nome === args.project);
    if (progetti.length === 0) {
      throw new Error(`Progetto '${args.project}' non trovato o non attivo.`);
    }
  }

  for (const project of progetti) {
    await processProject(client, args.model, project, args.dryRun);
  }
  log.step("Fase riscrittura titoli completata.");
}

if (require.main === module) {
  main().catch((e) => {
    log.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { parseJsonArray };
