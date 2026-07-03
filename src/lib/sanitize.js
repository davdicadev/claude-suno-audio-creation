"use strict";

/**
 * Sanificazione dei nomi file.
 *
 * Questo e il cuore della soluzione al problema che avevi segnalato: i comandi
 * PowerShell e il "concat" di FFMPEG si rompono quando un nome file contiene
 * apostrofi, virgolette, parentesi, accenti o altri caratteri speciali.
 *
 * Strategia "doppia versione":
 *  - nome file su disco = SICURO (solo lettere ASCII, numeri, spazi, trattini)
 *  - titolo "bello" per la tracklist YouTube = tenuto a parte, con tutti i
 *    caratteri, mai usato come nome file.
 */

// Mappa di traslitterazione per accenti/caratteri latini comuni -> ASCII.
const TRANSLIT = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "ā": "a",
  "è": "e", "é": "e", "ê": "e", "ë": "e", "ē": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i", "ī": "i",
  "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ø": "o", "ō": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u", "ū": "u",
  "ñ": "n", "ç": "c", "ß": "ss", "æ": "ae", "œ": "oe",
  "&": " and ", "@": " at ",
};

/**
 * Converte un titolo qualsiasi in un nome file SICURO.
 * Esempio: "Dreamin' in Rio (cafe)" -> "Dreamin in Rio cafe"
 *
 * @param {string} input        titolo grezzo o riscritto
 * @param {object} [opts]
 * @param {number} [opts.maxLen=80]  lunghezza massima
 * @returns {string} base del nome file, senza estensione
 */
function safeFileBase(input, opts = {}) {
  const maxLen = opts.maxLen || 80;
  let s = String(input == null ? "" : input);

  // Traslitterazione accenti/simboli noti (latin-1 supplement + latin extended-A).
  s = s.replace(/[À-ſ&@]/g, (ch) => TRANSLIT[ch.toLowerCase()] || " ");

  // Normalizza e rimuove i segni diacritici combinanti (U+0300..U+036F).
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

  // Tiene solo: lettere/numeri ASCII, spazio, trattino, underscore.
  s = s.replace(/[^A-Za-z0-9 _-]/g, " ");

  // Comprime spazi multipli e trim.
  s = s.replace(/\s+/g, " ").trim();

  // Comprime trattini/underscore multipli.
  s = s.replace(/[-_]{2,}/g, "-");

  if (s.length > maxLen) s = s.slice(0, maxLen).trim();

  // Non lasciare mai una base vuota.
  if (!s) s = "brano";

  return s;
}

/**
 * Pulisce un titolo "display" (per la tracklist): mantiene i caratteri leggibili
 * ma toglie caratteri di controllo e a-capo che romperebbero un file di testo
 * riga-per-riga.
 *
 * @param {string} input
 * @returns {string}
 */
function displayTitle(input) {
  let s = String(input == null ? "" : input);
  // rimuove caratteri di controllo (incl. a-capo, tab) -> spazio
  s = s.replace(/[\u0000-\u001F\u007F]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s || "Brano";
}

/**
 * Garantisce l'unicita di una base file dentro un insieme gia usato,
 * aggiungendo un suffisso numerico o l'id del brano.
 *
 * @param {string} base
 * @param {Set<string>} used    insieme (in minuscolo) delle basi gia assegnate
 * @param {string} [id]         id univoco del brano da usare come suffisso
 * @returns {string}
 */
function uniqueBase(base, used, id) {
  let candidate = base;
  if (!used.has(candidate.toLowerCase())) {
    used.add(candidate.toLowerCase());
    return candidate;
  }
  // primo tentativo: aggiunge un frammento dell'id
  if (id) {
    const frag = String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
    candidate = `${base} ${frag}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  // fallback: contatore incrementale
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
  candidate = `${base} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

module.exports = { safeFileBase, displayTitle, uniqueBase };
