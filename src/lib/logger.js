"use strict";

const fs = require("fs");

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

// File di log opzionale: utile con n8n, che NON mostra l'output del comando
// finché il processo non termina. Scrivendo anche su file puoi seguire i
// progressi in tempo reale aprendo il file (o con `tail`/`Get-Content -Wait`).
let logFile = process.env.SUNO_LOG_FILE || null;

function setLogFile(p) {
  logFile = p || null;
  if (logFile) {
    try {
      fs.mkdirSync(require("path").dirname(logFile), { recursive: true });
      fs.appendFileSync(
        logFile,
        `\n[${ts()}] [STEP] ===== nuova esecuzione =====\n`
      );
    } catch (_) {
      /* se non scrivibile, si continua solo su console */
    }
  }
}

function log(level, ...args) {
  const line = `[${ts()}] [${level}]`;
  if (level === "ERROR") console.error(line, ...args);
  else console.log(line, ...args);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, [line, ...args].join(" ") + "\n");
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  info: (...a) => log("INFO", ...a),
  warn: (...a) => log("WARN", ...a),
  error: (...a) => log("ERROR", ...a),
  step: (...a) => log("STEP", ...a),
  setLogFile,
};
