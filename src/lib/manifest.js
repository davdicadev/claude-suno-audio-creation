"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Il manifest.json di un progetto tiene traccia di tutti i brani scaricati:
 * id Suno, titolo originale, cartella (A/B/C), percorso file, e in seguito
 * il titolo riscritto da Claude (display + nome file sicuro).
 */

function load(manifestPath) {
  if (!fs.existsSync(manifestPath)) return { tracks: [] };
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`Manifest non valido (${manifestPath}): ${e.message}`);
  }
}

function save(manifestPath, data) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2), "utf8");
}

module.exports = { load, save };
