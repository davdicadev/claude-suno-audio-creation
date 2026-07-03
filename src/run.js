#!/usr/bin/env node
"use strict";

/**
 * Orchestratore: esegue in sequenza le tre fasi dell'automazione.
 *   1) generate   -> src/suno.js           (Playwright: genera + scarica in A/B/C)
 *   2) titles     -> src/rewrite-titles.js (Claude: riscrive titoli + rinomina)
 *   3) playlists  -> src/build-playlists.js(FFMPEG: monta playlist + tracklist)
 *
 * Uso:
 *   node src/run.js                         # tutte le fasi, tutti i progetti attivi
 *   node src/run.js --project canale-lofi   # tutte le fasi, un progetto
 *   node src/run.js --phase titles          # solo una fase
 *   node src/run.js --phase generate,playlists
 *   node src/run.js --config path.json
 *
 * Nota: n8n puo' anche chiamare i singoli script (vedi n8n/ e README), utile per
 * vedere l'avanzamento fase per fase.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const log = require("./lib/logger");

const PHASES = {
  generate: "suno.js",
  titles: "rewrite-titles.js",
  playlists: "build-playlists.js",
};

function parseArgs(argv) {
  const args = { project: null, config: null, phases: ["generate", "titles", "playlists"] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--phase") {
      args.phases = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

function runPhase(script, args) {
  const scriptPath = path.join(__dirname, script);
  const extra = [];
  if (args.project) extra.push("--project", args.project);
  if (args.config) extra.push("--config", args.config);
  log.step(`>>> Avvio fase: ${script} ${extra.join(" ")}`);
  const r = spawnSync(process.execPath, [scriptPath, ...extra], {
    stdio: "inherit",
  });
  if (r.status !== 0) {
    throw new Error(`Fase ${script} terminata con codice ${r.status}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  for (const phase of args.phases) {
    const script = PHASES[phase];
    if (!script) {
      throw new Error(
        `Fase sconosciuta: '${phase}'. Valide: ${Object.keys(PHASES).join(", ")}`
      );
    }
    runPhase(script, args);
  }
  log.step("Tutte le fasi richieste sono state completate.");
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    log.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
}
