#!/usr/bin/env node
"use strict";

/**
 * Fase 1: generazione brani su Suno via automazione del browser (Playwright) e
 * download in locale, smistati nelle cartelle A / B / C.
 *
 * - Usa un PROFILO PERSISTENTE: il login lo fai UNA volta a mano
 *     node src/suno.js --login-only
 *   poi la sessione resta salvata e lo script la riusa.
 * - La scoperta dei brani avviene leggendo le risposte che la pagina Suno
 *   riceve gia da sola durante la navigazione (nessuna API con chiave).
 * - Il download degli MP3 usa la stessa sessione autenticata del browser.
 *
 * Uso:
 *   node src/suno.js --login-only            # solo primo login
 *   node src/suno.js                         # tutti i progetti attivi
 *   node src/suno.js --project canale-lofi   # un solo progetto
 *   node src/suno.js --config path.json      # config alternativa
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadConfig } = require("./lib/config");
const manifestLib = require("./lib/manifest");
const SEL = require("./lib/suno-selectors");
const log = require("./lib/logger");

function parseArgs(argv) {
  const args = { loginOnly: false, project: null, config: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--login-only") args.loginOnly = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--config") args.config = argv[++i];
  }
  return args;
}

function ensureDirs(project) {
  for (const key of ["root", "A", "B", "C", "export", "tracklist"]) {
    fs.mkdirSync(project.dirs[key], { recursive: true });
  }
}

/** Ritorna il primo locator che esiste tra una lista di selettori. */
async function firstLocator(scope, selectors, timeout = 4000) {
  for (const s of selectors) {
    const loc = scope.locator(s).first();
    try {
      await loc.waitFor({ state: "visible", timeout });
      return loc;
    } catch (_) {
      /* prova il prossimo */
    }
  }
  return null;
}

/** Estrae ricorsivamente oggetti "clip" (id + audio_url) da un JSON qualsiasi. */
function extractClips(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) extractClips(el, out, seen);
    return;
  }
  const id = node.id || node.clip_id || node.song_id;
  const audio =
    node.audio_url || node.audioUrl || node.audio || node.mp3_url || null;
  if (id && audio && !seen.has(id)) {
    seen.add(id);
    out.push({
      id: String(id),
      audioUrl: String(audio),
      title: node.title || node.name || "brano",
      status: node.status || node.state || "complete",
      createdAt:
        node.created_at || node.createdAt || node.created || node.date || null,
    });
  }
  for (const k of Object.keys(node)) {
    if (k === "id") continue;
    extractClips(node[k], out, seen);
  }
}

/**
 * Collega un listener alle risposte di rete. Serve a due scopi:
 *  - dalle risposte di GENERAZIONE ricava gli id dei brani appena creati
 *    (expectedIds): cosi sappiamo esattamente quali brani sono di QUESTA
 *    esecuzione e non tocchiamo la libreria vecchia;
 *  - dai FEED aggiorna lo stato/audio_url di quei brani in `store`.
 * Ritorna una funzione per staccare il listener a fine progetto.
 */
function attachClipCollector(context, store, expectedIds) {
  const handler = async (resp) => {
    const url = resp.url();
    const isFeed = SEL.feedUrlFragments.some((f) => url.includes(f));
    const isGen = SEL.generateUrlFragments.some((f) => url.includes(f));
    if (!isFeed && !isGen) return;
    let json;
    try {
      json = await resp.json();
    } catch (_) {
      return;
    }
    const found = [];
    extractClips(json, found, new Set());
    for (const c of found) {
      // aggiorna sempre lo store (l'ultima versione vince: status/audio_url)
      const prev = store.get(c.id);
      store.set(c.id, prev ? { ...prev, ...c } : c);
      // se il brano arriva da una risposta di generazione, e "nostro"
      if (isGen) expectedIds.add(c.id);
    }
  };
  context.on("response", handler);
  return () => context.off("response", handler);
}

/**
 * Limita i brani a quelli di QUESTA esecuzione:
 *  - se abbiamo intercettato gli id di generazione, usiamo solo quelli;
 *  - altrimenti (fallback) teniamo i brani creati dopo l'inizio run.
 */
function scopeClips(store, expectedIds, runStart) {
  const all = [...store.values()];
  if (expectedIds.size > 0) {
    return all.filter((c) => expectedIds.has(c.id));
  }
  const cutoff = runStart - 60 * 1000; // 1 min di margine
  return all.filter((c) => {
    const t = c.createdAt ? Date.parse(c.createdAt) : NaN;
    return Number.isFinite(t) ? t >= cutoff : false;
  });
}

/** Lancia le generazioni per un progetto (senza attendere il completamento). */
async function generateForProject(page, project) {
  const base = project._sunoUrl;
  log.step(`[${project.nome}] apro la pagina di creazione`);
  await page.goto(base + SEL.createUrl, {
    waitUntil: "domcontentloaded",
    timeout: SEL.timeouts.navigation,
  });
  await page.waitForTimeout(2000);

  for (let pi = 0; pi < project.prompts.length; pi++) {
    const prompt = project.prompts[pi];
    const clicks = project.fabbisogno.clickPerPrompt[pi] || 0;
    if (clicks < 1) continue;
    log.step(
      `[${project.nome}] prompt ${pi + 1}/${project.prompts.length} -> ${clicks} generazioni ` +
        `(strumentale: ${prompt.strumentale ? "si" : "no"})`
    );

    // Imposta il toggle strumentale allo stato richiesto.
    await setInstrumental(page, prompt.strumentale);

    for (let n = 0; n < clicks; n++) {
      const textarea = await firstLocator(page, SEL.promptTextarea);
      if (!textarea) {
        throw new Error(
          `[${project.nome}] campo prompt non trovato. Aggiorna 'promptTextarea' in src/lib/suno-selectors.js`
        );
      }
      await textarea.fill(prompt.testo);
      await page.waitForTimeout(300);

      const createBtn = await firstLocator(page, SEL.createButton);
      if (!createBtn) {
        throw new Error(
          `[${project.nome}] bottone Create non trovato. Aggiorna 'createButton' in src/lib/suno-selectors.js`
        );
      }
      await createBtn.click();
      log.info(`[${project.nome}]   generazione ${n + 1}/${clicks} avviata`);
      await page.waitForTimeout(SEL.timeouts.afterCreateClick);
    }
  }
}

async function setInstrumental(page, wanted) {
  const toggle = await firstLocator(page, SEL.instrumentalToggle, 2500);
  if (!toggle) {
    log.warn(
      "Toggle 'Instrumental' non trovato: procedo senza modificarlo. " +
        "Se serve, aggiorna 'instrumentalToggle' in src/lib/suno-selectors.js"
    );
    return;
  }
  let isOn = null;
  try {
    const pressed = await toggle.getAttribute("aria-pressed");
    const checked = await toggle.getAttribute("aria-checked");
    if (pressed != null) isOn = pressed === "true";
    else if (checked != null) isOn = checked === "true";
  } catch (_) {
    /* stato non leggibile */
  }
  if (isOn === null || isOn !== wanted) {
    try {
      await toggle.click();
      await page.waitForTimeout(300);
    } catch (_) {
      log.warn("Non sono riuscito a cliccare il toggle strumentale.");
    }
  }
}

/** Ricarica periodicamente e accumula i brani completi finche non bastano. */
async function pollUntilReady(page, project, store, expectedIds, runStart) {
  const base = project._sunoUrl;
  const target = project.fabbisogno.clickTotali * 2; // 2 brani per click
  const enough = project.fabbisogno.bisognoA + project.fabbisogno.bisognoB;
  const start = Date.now();
  let lastReady = -1;
  let stable = 0;

  log.step(
    `[${project.nome}] attendo il completamento dei brani (obiettivo ~${target}, minimo utile ${enough})`
  );

  while (Date.now() - start < SEL.timeouts.pollMax) {
    // Ricarica la libreria: la pagina rifara' le chiamate feed che intercettiamo.
    try {
      await page.goto(base + SEL.createUrl, {
        waitUntil: "domcontentloaded",
        timeout: SEL.timeouts.navigation,
      });
    } catch (_) {
      /* riprova al prossimo giro */
    }
    await page.waitForTimeout(4000);

    const ready = scopeClips(store, expectedIds, runStart).filter(
      (c) => c.audioUrl && isComplete(c.status)
    );
    log.info(
      `[${project.nome}]   brani pronti: ${ready.length} ` +
        `(trascorsi ${Math.round((Date.now() - start) / 1000)}s)`
    );

    if (ready.length >= target) {
      log.info(`[${project.nome}] raggiunto l'obiettivo di brani.`);
      break;
    }
    if (ready.length === lastReady) {
      stable += 1;
      // Se il numero non cresce da un po' ma ne ho abbastanza, esco.
      if (stable >= 3 && ready.length >= enough) {
        log.info(`[${project.nome}] conteggio stabile e sufficiente, procedo.`);
        break;
      }
    } else {
      stable = 0;
      lastReady = ready.length;
    }
    await page.waitForTimeout(SEL.timeouts.pollInterval);
  }

  return scopeClips(store, expectedIds, runStart).filter(
    (c) => c.audioUrl && isComplete(c.status)
  );
}

function isComplete(status) {
  if (!status) return true;
  const s = String(status).toLowerCase();
  return s === "complete" || s === "completed" || s === "streaming" || s === "done";
}

/** Scarica un MP3 usando la sessione autenticata del browser. */
async function downloadMp3(context, url, destPath) {
  const resp = await context.request.get(url, { timeout: 120000 });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()} su ${url}`);
  const buf = await resp.body();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

/**
 * Smista i brani in A/B/C e scarica gli MP3.
 * Coppia = stesso titolo creati entro la tolleranza -> 1o in A, 2o in B.
 * Singolo (senza gemello) -> C.
 */
async function sortAndDownload(context, project, clips) {
  const tolMs = 120 * 1000;
  const t = (c) => (c.createdAt ? Date.parse(c.createdAt) : 0) || 0;
  const norm = (c) => String(c.title || "brano").trim().toLowerCase();

  // Dedup per id.
  const byId = new Map();
  for (const c of clips) byId.set(c.id, c);
  const all = [...byId.values()];

  // Raggruppa per titolo.
  const groups = new Map();
  for (const c of all) {
    const k = norm(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }

  const assigned = []; // { clip, folder }
  for (const arr of groups.values()) {
    arr.sort((a, b) => t(a) - t(b));
    let i = 0;
    while (i < arr.length) {
      if (i + 1 < arr.length && Math.abs(t(arr[i + 1]) - t(arr[i])) <= tolMs) {
        assigned.push({ clip: arr[i], folder: "A" });
        assigned.push({ clip: arr[i + 1], folder: "B" });
        i += 2;
      } else {
        assigned.push({ clip: arr[i], folder: "C" });
        i += 1;
      }
    }
  }

  const tracks = [];
  let ok = 0;
  let fail = 0;
  for (const { clip, folder } of assigned) {
    const fileName = `${sanitizeRaw(clip.title)}_${clip.id}.mp3`;
    const rel = path.join(`cartella-${folder}`, fileName);
    const dest = path.join(project.dirs.root, rel);
    if (fs.existsSync(dest)) {
      tracks.push(trackRecord(clip, folder, rel));
      continue;
    }
    try {
      await downloadMp3(context, clip.audioUrl, dest);
      ok += 1;
      tracks.push(trackRecord(clip, folder, rel));
      log.info(`[${project.nome}]   scaricato ${rel}`);
    } catch (e) {
      fail += 1;
      log.warn(`[${project.nome}]   download fallito ${clip.id}: ${e.message}`);
    }
  }
  log.step(`[${project.nome}] download completati: ${ok}, falliti: ${fail}`);
  return tracks;
}

function trackRecord(clip, folder, rel) {
  return {
    id: clip.id,
    originalTitle: clip.title || "brano",
    folder,
    file: rel.split(path.sep).join("/"),
    createdAt: clip.createdAt || null,
  };
}

// Nome file provvisorio (prima della riscrittura Claude): togli i caratteri
// che romperebbero il filesystem, senza ancora l'ottimizzazione titoli.
function sanitizeRaw(title) {
  return String(title || "brano")
    .replace(/[^a-z0-9\-_ ]/gi, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "brano";
}

async function runLoginOnly(context, sunoUrl) {
  const page = await context.newPage();
  await page.goto(sunoUrl, { waitUntil: "domcontentloaded" });
  log.step(
    "Finestra Suno aperta. Esegui il LOGIN a mano (Google/Discord/email). " +
      "Quando hai finito e vedi la tua libreria, torna qui e premi INVIO."
  );
  await waitForEnter();
  log.info("Login salvato nel profilo persistente. Chiudo.");
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  fs.mkdirSync(cfg.browserProfileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(cfg.browserProfileDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });

  try {
    if (args.loginOnly) {
      await runLoginOnly(context, cfg.sunoUrl);
      return;
    }

    let progetti = cfg.progetti.filter((p) => p.attivo);
    if (args.project) {
      progetti = progetti.filter((p) => p.nome === args.project);
      if (progetti.length === 0) {
        throw new Error(`Progetto '${args.project}' non trovato o non attivo.`);
      }
    }
    if (progetti.length === 0) {
      log.warn("Nessun progetto attivo da elaborare.");
      return;
    }

    const page = context.pages()[0] || (await context.newPage());

    for (const project of progetti) {
      project._sunoUrl = cfg.sunoUrl;
      ensureDirs(project);
      log.step(
        `=== Progetto '${project.nome}': ${project.fabbisogno.clickTotali} generazioni, ` +
          `obiettivo A=${project.fabbisogno.bisognoA} B=${project.fabbisogno.bisognoB} ===`
      );

      const store = new Map();
      const expectedIds = new Set();
      const detach = attachClipCollector(context, store, expectedIds);
      const runStart = Date.now();

      let tracks = [];
      try {
        await generateForProject(page, project);
        const ready = await pollUntilReady(
          page,
          project,
          store,
          expectedIds,
          runStart
        );
        log.step(
          `[${project.nome}] brani pronti da scaricare: ${ready.length} ` +
            `(id di generazione intercettati: ${expectedIds.size})`
        );

        tracks = await sortAndDownload(context, project, ready);
      } finally {
        detach();
      }

      const manifest = {
        project: project.nome,
        runAt: new Date().toISOString(),
        keywordsTitoli: project.keywordsTitoli,
        playlist: project.playlist,
        tracks,
      };
      manifestLib.save(project.dirs.manifest, manifest);
      log.step(
        `[${project.nome}] manifest salvato: ${project.dirs.manifest} (${tracks.length} brani)`
      );
    }
    log.step("Fase generazione/download completata.");
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    log.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { extractClips, sanitizeRaw };
