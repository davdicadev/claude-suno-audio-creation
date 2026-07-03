#!/usr/bin/env node
"use strict";

/**
 * Fase 1: generazione brani su Suno via automazione del browser (Playwright) e
 * download in locale, smistati nelle cartelle A / B / C.
 *
 * Come funziona (per ogni progetto):
 *   - usa il PROFILO BROWSER indicato dal progetto (= un account Suno). Progetti
 *     con lo stesso 'sunoProfilo' condividono l'account; valori diversi usano
 *     account diversi (elaborati in sequenza nella stessa esecuzione);
 *   - lancia le generazioni A LOTTI di 'maxGenerazioniPerBatch' (max 10, il
 *     massimo che Suno elabora insieme, ~20 brani), ATTENDE il completamento del
 *     lotto, SCARICA i brani, poi prosegue col lotto successivo;
 *   - lo smistamento A/B/C usa le COPPIE restituite da ogni generazione (1o
 *     brano -> A, 2o -> B; generazione singola -> C).
 *
 * La scoperta dei brani avviene leggendo le risposte che la pagina Suno riceve
 * gia da sola (nessuna API con chiave). Il download usa la sessione autenticata.
 *
 * Uso:
 *   node src/suno.js --login-only [--profile nome]   # primo login di un account
 *   node src/suno.js                                  # tutti i progetti attivi
 *   node src/suno.js --project canale-lofi            # un solo progetto
 *   node src/suno.js --config path.json               # config alternativa
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadConfig } = require("./lib/config");
const manifestLib = require("./lib/manifest");
const SEL = require("./lib/suno-selectors");
const log = require("./lib/logger");

function parseArgs(argv) {
  const args = { loginOnly: false, project: null, config: null, profile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--login-only") args.loginOnly = true;
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--profile") args.profile = argv[++i];
  }
  return args;
}

function ensureDirs(project) {
  for (const key of ["root", "A", "B", "C", "export", "tracklist"]) {
    fs.mkdirSync(project.dirs[key], { recursive: true });
  }
}

function safeProfileDirName(name) {
  return String(name || "default").replace(/[^A-Za-z0-9_-]/g, "_") || "default";
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

/** Un oggetto sembra un "clip" di Suno? (id lungo + almeno un campo tipico) */
function looksLikeClip(node) {
  if (!node || typeof node !== "object") return false;
  const id = node.id || node.clip_id || node.song_id;
  if (typeof id !== "string") return false;
  const hasAudio =
    node.audio_url || node.audioUrl || node.audio || node.mp3_url;
  const hasField =
    hasAudio ||
    node.status ||
    node.state ||
    node.title != null ||
    node.created_at ||
    node.createdAt;
  return !!hasField && (id.length >= 16 || !!hasAudio);
}

function toClip(node) {
  return {
    id: String(node.id || node.clip_id || node.song_id),
    audioUrl:
      node.audio_url || node.audioUrl || node.audio || node.mp3_url || null,
    title: node.title != null ? node.title : node.name || "brano",
    status: node.status || node.state || null,
    createdAt:
      node.created_at || node.createdAt || node.created || node.date || null,
  };
}

/** Estrae ricorsivamente i clip da un JSON qualsiasi (in ordine di comparsa). */
function extractClipObjects(node, out, seen) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const el of node) extractClipObjects(el, out, seen);
    return;
  }
  if (looksLikeClip(node)) {
    const c = toClip(node);
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  for (const k of Object.keys(node)) {
    if (k === "id") continue;
    extractClipObjects(node[k], out, seen);
  }
}

// Compatibilita: versione storica che richiede audio_url (usata nei test).
function extractClips(node, out, seen) {
  const tmp = [];
  extractClipObjects(node, tmp, new Set());
  for (const c of tmp) {
    if (c.audioUrl && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
}

/**
 * Listener sulle risposte di rete:
 *  - dalle risposte di GENERAZIONE ricava le COPPIE di brani appena creati
 *    (una "generazione" = i clip restituiti da una singola risposta di generate)
 *    e i loro id (expectedIds = brani di QUESTA esecuzione);
 *  - dai FEED aggiorna stato/audio_url dei brani in `store`.
 * Ritorna una funzione per staccare il listener.
 */
function attachClipCollector(context, ctx) {
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
    extractClipObjects(json, found, new Set());
    if (found.length === 0) return;

    for (const c of found) {
      const prev = ctx.store.get(c.id);
      // l'ultima versione vince, ma non azzerare audioUrl gia noto
      const merged = prev ? { ...prev, ...c } : c;
      if (prev && prev.audioUrl && !c.audioUrl) merged.audioUrl = prev.audioUrl;
      ctx.store.set(c.id, merged);
    }
    if (isGen) {
      const ids = found.map((c) => c.id);
      ctx.generations.push(ids);
      for (const id of ids) ctx.expectedIds.add(id);
    }
  };
  context.on("response", handler);
  return () => context.off("response", handler);
}

/** Limita i brani a quelli di QUESTA esecuzione (id di generazione o tempo). */
function scopeClips(ctx, runStart) {
  const all = [...ctx.store.values()];
  if (ctx.expectedIds.size > 0) {
    return all.filter((c) => ctx.expectedIds.has(c.id));
  }
  const cutoff = runStart - 60 * 1000;
  return all.filter((c) => {
    const t = c.createdAt ? Date.parse(c.createdAt) : NaN;
    return Number.isFinite(t) ? t >= cutoff : false;
  });
}

function isComplete(status) {
  if (!status) return true;
  const s = String(status).toLowerCase();
  return (
    s === "complete" || s === "completed" || s === "streaming" || s === "done"
  );
}

function isReady(clip) {
  return !!(clip && clip.audioUrl && isComplete(clip.status));
}

/** Costruisce la coda dei "click" di generazione (uno per brano-coppia). */
function buildClickQueue(project) {
  const q = [];
  project.prompts.forEach((p, i) => {
    const n = project.fabbisogno.clickPerPrompt[i] || 0;
    for (let k = 0; k < n; k++) {
      q.push({ testo: p.testo, strumentale: p.strumentale });
    }
  });
  return q;
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

/** Lancia un lotto di generazioni (senza attendere il completamento). */
async function launchBatch(page, project, batch) {
  const base = project._sunoUrl;
  await page.goto(base + SEL.createUrl, {
    waitUntil: "domcontentloaded",
    timeout: SEL.timeouts.navigation,
  });
  await page.waitForTimeout(1500);

  for (let i = 0; i < batch.length; i++) {
    const click = batch[i];
    await setInstrumental(page, click.strumentale);

    const textarea = await firstLocator(page, SEL.promptTextarea);
    if (!textarea) {
      throw new Error(
        `[${project.nome}] campo prompt non trovato. Aggiorna 'promptTextarea' in src/lib/suno-selectors.js`
      );
    }
    await textarea.fill(click.testo);
    await page.waitForTimeout(300);

    const createBtn = await firstLocator(page, SEL.createButton);
    if (!createBtn) {
      throw new Error(
        `[${project.nome}] bottone Create non trovato. Aggiorna 'createButton' in src/lib/suno-selectors.js`
      );
    }
    await createBtn.click();
    log.info(
      `[${project.nome}]   generazione ${i + 1}/${batch.length} del lotto avviata ` +
        `(strumentale: ${click.strumentale ? "si" : "no"})`
    );
    await page.waitForTimeout(SEL.timeouts.afterCreateClick);
  }
}

/** Quanti brani del run sono pronti e NON ancora scaricati. */
function readyNotDownloaded(ctx, runStart) {
  return scopeClips(ctx, runStart).filter(
    (c) => isReady(c) && !ctx.downloadedIds.has(c.id)
  );
}

/** Attende il completamento di un lotto (o timeout), ricaricando la libreria. */
async function pollBatch(page, project, ctx, runStart, expectedNew) {
  const base = project._sunoUrl;
  const start = Date.now();
  let last = -1;
  let stable = 0;

  log.step(
    `[${project.nome}]   attendo il completamento del lotto (~${expectedNew} brani attesi)`
  );

  while (Date.now() - start < SEL.timeouts.pollMaxPerBatch) {
    try {
      await page.goto(base + SEL.createUrl, {
        waitUntil: "domcontentloaded",
        timeout: SEL.timeouts.navigation,
      });
    } catch (_) {
      /* riprova */
    }
    await page.waitForTimeout(4000);

    const count = readyNotDownloaded(ctx, runStart).length;
    log.info(
      `[${project.nome}]   pronti nel lotto: ${count}/${expectedNew} ` +
        `(${Math.round((Date.now() - start) / 1000)}s)`
    );

    if (count >= expectedNew) break;
    if (count === last) {
      stable += 1;
      if (stable >= 3 && count > 0) {
        log.info(`[${project.nome}]   conteggio stabile, procedo col download.`);
        break;
      }
    } else {
      stable = 0;
      last = count;
    }
    await page.waitForTimeout(SEL.timeouts.pollInterval);
  }
}

// Ordina i clip di una coppia/gruppo e assegna A / B / C.
function assignGroupClips(clips, result) {
  const t = (c) => (c.createdAt ? Date.parse(c.createdAt) : 0) || 0;
  const ordered = clips
    .slice()
    .sort((a, b) => t(a) - t(b) || String(a.id).localeCompare(String(b.id)));
  if (ordered.length >= 2) {
    result.push({ clip: ordered[0], folder: "A" });
    result.push({ clip: ordered[1], folder: "B" });
    for (let i = 2; i < ordered.length; i++) {
      result.push({ clip: ordered[i], folder: "C" });
    }
  } else if (ordered.length === 1) {
    result.push({ clip: ordered[0], folder: "C" });
  }
}

// Fallback: accoppia per titolo + vicinanza temporale (se mancano i gruppi).
function pairByTitleTime(clips, result, finalize) {
  const tol = 120 * 1000;
  const t = (c) => (c.createdAt ? Date.parse(c.createdAt) : 0) || 0;
  const norm = (c) => String(c.title || "brano").trim().toLowerCase();
  const groups = new Map();
  for (const c of clips) {
    const k = norm(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => t(a) - t(b));
    let i = 0;
    while (i < arr.length) {
      if (i + 1 < arr.length && Math.abs(t(arr[i + 1]) - t(arr[i])) <= tol) {
        result.push({ clip: arr[i], folder: "A" });
        result.push({ clip: arr[i + 1], folder: "B" });
        i += 2;
      } else if (finalize) {
        result.push({ clip: arr[i], folder: "C" });
        i += 1;
      } else {
        break; // brano spaiato: aspetta il gemello in un giro successivo
      }
    }
  }
}

/**
 * Decide cosa scaricare adesso.
 *  - Gruppi di generazione COMPLETI (tutti i brani pronti) -> A/B/C accurato.
 *  - Con finalize=true assegna anche i gruppi/brani rimasti a meta.
 *  - Fallback per brani non coperti da alcun gruppo: titolo+tempo.
 */
function planAssignments(ctx, runStart, finalize) {
  const result = [];
  const covered = new Set();

  for (const g of ctx.generations) {
    const clips = g.map((id) => ctx.store.get(id)).filter(Boolean);
    const usable = clips.filter(
      (c) => isReady(c) && !ctx.downloadedIds.has(c.id)
    );
    const allReady = g.length > 0 && g.every((id) => isReady(ctx.store.get(id)));
    const alreadyDone = g.every((id) => ctx.downloadedIds.has(id));
    if (alreadyDone) {
      for (const id of g) covered.add(id);
      continue;
    }
    if ((allReady || finalize) && usable.length > 0) {
      assignGroupClips(usable, result);
      for (const c of usable) covered.add(c.id);
    }
  }

  // Fallback: brani pronti del run non coperti da nessun gruppo.
  const rest = readyNotDownloaded(ctx, runStart).filter(
    (c) => !covered.has(c.id)
  );
  if (rest.length > 0) pairByTitleTime(rest, result, finalize);

  return result;
}

/** Scarica un MP3 usando la sessione autenticata del browser. */
async function downloadMp3(context, url, destPath) {
  const resp = await context.request.get(url, { timeout: 120000 });
  if (!resp.ok()) throw new Error(`HTTP ${resp.status()} su ${url}`);
  const buf = await resp.body();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
}

// Nome file provvisorio (prima della riscrittura Claude).
function sanitizeRaw(title) {
  return (
    String(title || "brano")
      .replace(/[^a-z0-9\-_ ]/gi, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "brano"
  );
}

/** Scarica le assegnazioni e ritorna i record per il manifest. */
async function downloadAssignments(context, project, assignments, ctx) {
  const tracks = [];
  let ok = 0;
  let fail = 0;
  for (const { clip, folder } of assignments) {
    if (ctx.downloadedIds.has(clip.id)) continue;
    const fileName = `${sanitizeRaw(clip.title)}_${clip.id}.mp3`;
    const rel = `cartella-${folder}/${fileName}`;
    const dest = path.join(project.dirs.root, rel.split("/").join(path.sep));
    const record = {
      id: clip.id,
      originalTitle: clip.title || "brano",
      folder,
      file: rel,
      createdAt: clip.createdAt || null,
    };
    if (fs.existsSync(dest)) {
      ctx.downloadedIds.add(clip.id);
      tracks.push(record);
      continue;
    }
    try {
      await downloadMp3(context, clip.audioUrl, dest);
      ctx.downloadedIds.add(clip.id);
      ok += 1;
      tracks.push(record);
      log.info(`[${project.nome}]   scaricato ${rel}`);
    } catch (e) {
      fail += 1;
      log.warn(`[${project.nome}]   download fallito ${clip.id}: ${e.message}`);
    }
  }
  if (ok || fail) {
    log.info(`[${project.nome}]   lotto: scaricati ${ok}, falliti ${fail}`);
  }
  return tracks;
}

/** Elabora un progetto: generazione a lotti + download progressivo. */
async function processProject(context, page, project) {
  ensureDirs(project);
  const ctx = {
    store: new Map(),
    expectedIds: new Set(),
    generations: [],
    downloadedIds: new Set(),
  };
  const detach = attachClipCollector(context, ctx);
  const runStart = Date.now();
  const allTracks = [];

  log.step(
    `=== Progetto '${project.nome}' (account: ${project.sunoProfilo}): ` +
      `${project.fabbisogno.clickTotali} generazioni a lotti di ` +
      `${project.maxGenerazioniPerBatch}, obiettivo A=${project.fabbisogno.bisognoA} ` +
      `B=${project.fabbisogno.bisognoB} ===`
  );

  try {
    const queue = buildClickQueue(project);
    const batchSize = project.maxGenerazioniPerBatch;
    let batchNum = 0;
    const totBatch = Math.ceil(queue.length / batchSize);

    while (queue.length > 0) {
      batchNum += 1;
      const batch = queue.splice(0, batchSize);
      log.step(
        `[${project.nome}] lotto ${batchNum}/${totBatch}: ${batch.length} generazioni`
      );

      await launchBatch(page, project, batch);
      await pollBatch(page, project, ctx, runStart, batch.length * 2);

      const plan = planAssignments(ctx, runStart, false);
      const tracks = await downloadAssignments(context, project, plan, ctx);
      allTracks.push(...tracks);
      log.info(
        `[${project.nome}] lotto ${batchNum} completato. Totale scaricati finora: ${allTracks.length}`
      );
    }

    // Passata finale: recupera eventuali brani rimasti indietro.
    log.step(`[${project.nome}] passata finale per gli ultimi brani...`);
    await pollBatch(page, project, ctx, runStart, 1);
    const finalPlan = planAssignments(ctx, runStart, true);
    const finalTracks = await downloadAssignments(context, project, finalPlan, ctx);
    allTracks.push(...finalTracks);
  } finally {
    detach();
  }

  const manifest = {
    project: project.nome,
    sunoProfilo: project.sunoProfilo,
    runAt: new Date().toISOString(),
    keywordsTitoli: project.keywordsTitoli,
    playlist: project.playlist,
    tracks: allTracks,
  };
  manifestLib.save(project.dirs.manifest, manifest);
  const counts = allTracks.reduce(
    (a, t) => ((a[t.folder] = (a[t.folder] || 0) + 1), a),
    {}
  );
  log.step(
    `[${project.nome}] manifest salvato (${allTracks.length} brani: ` +
      `A=${counts.A || 0} B=${counts.B || 0} C=${counts.C || 0})`
  );
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

async function openContextForProfile(cfg, profile) {
  const dir = path.join(cfg.browserProfilesDir, safeProfileDirName(profile));
  fs.mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  const page = context.pages()[0] || (await context.newPage());
  return { context, page };
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args.config);
  fs.mkdirSync(cfg.browserProfilesDir, { recursive: true });

  // --- Modalita solo login ---
  if (args.loginOnly) {
    const profile = args.profile || "default";
    const { context, page } = await openContextForProfile(cfg, profile);
    try {
      await page.goto(cfg.sunoUrl, { waitUntil: "domcontentloaded" });
      log.step(
        `Profilo '${profile}': esegui il LOGIN a Suno a mano. ` +
          "Quando vedi la tua libreria, torna qui e premi INVIO."
      );
      await waitForEnter();
      log.info(`Login del profilo '${profile}' salvato.`);
    } finally {
      await context.close();
    }
    return;
  }

  // --- Elaborazione progetti (raggruppati per account/profilo) ---
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

  // Ordina per profilo cosi progetti dello stesso account restano vicini e
  // riusano lo stesso browser senza riaprirlo.
  progetti.sort((a, b) => a.sunoProfilo.localeCompare(b.sunoProfilo));

  let current = null; // { profile, context, page }
  try {
    for (const project of progetti) {
      project._sunoUrl = cfg.sunoUrl;
      if (!current || current.profile !== project.sunoProfilo) {
        if (current) await current.context.close();
        log.step(`Apro il browser per l'account Suno '${project.sunoProfilo}'.`);
        const { context, page } = await openContextForProfile(
          cfg,
          project.sunoProfilo
        );
        current = { profile: project.sunoProfilo, context, page };
      }
      await processProject(current.context, current.page, project);
    }
    log.step("Fase generazione/download completata.");
  } finally {
    if (current) await current.context.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    log.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = {
  extractClips,
  extractClipObjects,
  sanitizeRaw,
  assignGroupClips,
  pairByTitleTime,
  planAssignments,
  buildClickQueue,
};
