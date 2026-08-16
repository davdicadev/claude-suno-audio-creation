"use strict";

/**
 * Apertura di un brano in STUDIO, direttamente dalla pagina /create.
 *
 * DUE CAMBIAMENTI RISPETTO AL GIRO PRECEDENTE
 *
 *  1) NIENTE pagina del brano. In /create ogni riga della lista ha gia' il suo
 *     menu (…) con dentro Edit -> Open in Studio. Aprire prima /song/<id> era
 *     un passaggio in piu' (~6 secondi, un caricamento, un altro punto in cui
 *     perdersi) e non serviva a nulla.
 *
 *  2) MOUSE VIRTUALE. Tutti i passaggi nei menu si fanno muovendo davvero il
 *     puntatore (vedi lib/human-mouse.js), non con click che lo teletrasportano.
 *     I sottomenu di Suno si richiudono se il puntatore "salta": e' il motivo
 *     per cui muovendo il mouse a mano l'automazione funzionava e da sola no.
 *
 * Il menu si cerca SEMPRE dentro la riga del brano voluto: cosi' sparisce anche
 * il problema dei "52 menu (…) in pagina, ne provo 6 finche' uno funziona".
 */

const SEL = require("./suno-selectors");
const hm = require("./human-mouse");
const log = require("./logger");

const S = SEL.studio;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** I menu attualmente aperti e visibili (l'ultimo e' il piu' interno). */
function menuVisibili(page) {
  return page.locator(S.menuContainer).locator("visible=true");
}

/** Aspetta che ci siano almeno `quanti` menu aperti. Ritorna il piu' interno. */
async function attendiMenu(page, quanti, timeout) {
  const scadenza = Date.now() + timeout;
  const menus = menuVisibili(page);
  while (Date.now() < scadenza) {
    const n = await menus.count().catch(() => 0);
    if (n >= quanti) return menus.nth(n - 1);
    await page.waitForTimeout(120);
  }
  return null;
}

/** Elenco leggibile delle voci di UN menu (solo quelle, non tutta la pagina). */
async function vociDi(menu) {
  const items = menu.locator(S.menuItem);
  const n = await items.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = await items
      .nth(i)
      .innerText()
      .catch(() => "");
    const pulito = String(t).replace(/\s+/g, " ").trim();
    if (pulito) out.push(pulito);
  }
  return out;
}

/** Una voce di menu per testo esatto (case-insensitive), dentro QUEL menu. */
function vocePerTesto(menu, testo) {
  return menu
    .locator(S.menuItem)
    .filter({ hasText: new RegExp(`^\\s*${escapeRe(testo)}\\s*$`, "i") })
    .first();
}

/**
 * Elenca i brani presenti nella pagina /create leggendo i link /song/<id>.
 * Nessuna API, nessun credito: e' solo il DOM che il browser ha gia'.
 */
async function elencaBrani(page) {
  return page.evaluate(() => {
    const out = [];
    const visti = new Set();
    for (const a of document.querySelectorAll('a[href*="/song/"]')) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/song\/([0-9a-fA-F-]{16,})/);
      if (!m || visti.has(m[1])) continue;
      visti.add(m[1]);
      const testo = (a.innerText || a.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim();
      out.push({ id: m[1], titolo: testo.slice(0, 80) || "(senza titolo)" });
    }
    return out;
  });
}

/**
 * La RIGA della lista che contiene il brano: si parte dal link /song/<id> e si
 * risale al primo contenitore che ha dentro anche il bottone (…). Cosi' il menu
 * che apriremo e' per forza quello di QUESTO brano.
 */
async function trovaRigaBrano(page, { songId, titolo }) {
  const ancore = [];
  if (songId) ancore.push(page.locator(`a[href*="${songId}"]`).first());
  if (titolo) {
    ancore.push(
      page
        .locator("a", { hasText: new RegExp(escapeRe(titolo), "i") })
        .first()
    );
  }

  for (const ancora of ancore) {
    if ((await ancora.count().catch(() => 0)) === 0) continue;
    for (const sel of S.moreMenuButton) {
      // ancestor:: e' in ordine inverso, quindi [1] e' il contenitore PIU'
      // VICINO al link che contiene anche il bottone (…).
      const riga = ancora
        .locator(
          `xpath=ancestor::*[.//button[${xpathPredicato(sel)}]][1]`
        )
        .first();
      if ((await riga.count().catch(() => 0)) > 0) {
        const bottone = riga.locator(sel).first();
        if ((await bottone.count().catch(() => 0)) > 0) {
          return { riga, bottone, selettore: sel };
        }
      }
    }
  }
  return null;
}

/**
 * Traduce i selettori CSS che usiamo per il bottone (…) in un predicato XPath.
 * Ne servono pochi e semplici: aria-label esatto o parziale.
 */
function xpathPredicato(sel) {
  const esatto = sel.match(/\[aria-label="([^"]+)"\]/);
  if (esatto) return `@aria-label="${esatto[1]}"`;
  const parziale = sel.match(/\[aria-label\*="([^"]+)" i\]/);
  if (parziale) {
    const v = parziale[1].toLowerCase();
    return `contains(translate(@aria-label,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'${v}')`;
  }
  const haspopup = sel.match(/\[aria-haspopup="([^"]+)"\]/);
  if (haspopup) return `@aria-haspopup="${haspopup[1]}"`;
  return "@aria-label";
}

/**
 * Entra in un sottomenu passando PRIMA dal bordo del sottomenu stesso.
 * Radix chiude il sottomenu se il puntatore esce dal "triangolo" che va dalla
 * voce al pannello: muovendosi in orizzontale verso il pannello e solo dopo
 * verso la voce, il percorso resta valido e il sottomenu non si chiude.
 */
async function entraNelSottomenu(page, sottomenu, voce) {
  const bSub = await hm.box(sottomenu);
  const bVoce = await hm.box(voce);
  const partenza = hm.posizione(page);

  // 1) sul bordo del pannello, alla stessa altezza da cui veniamo
  const bordoX = bSub.x + Math.min(14, bSub.width * 0.2);
  const bordoY = Math.min(
    Math.max(partenza.y, bSub.y + 6),
    bSub.y + bSub.height - 6
  );
  // 2) dentro il pannello, all'altezza della voce
  const dentroX = bSub.x + Math.min(40, bSub.width * 0.35);
  const dentroY = bVoce.y + bVoce.height / 2;

  await hm.muoviLungo(page, [
    { x: bordoX, y: bordoY },
    { x: dentroX, y: dentroY },
  ]);
}

/**
 * Se compare la finestra "come vuoi aprirlo in Studio?", sceglie la prima
 * opzione utile (traccia singola / mix completo: nessun credito).
 * @returns {boolean} true se ha cliccato qualcosa
 */
async function gestisciDialogo(page, prefisso = "") {
  const dialogo = page.locator(S.dialogo).locator("visible=true").first();
  try {
    await dialogo.waitFor({ state: "visible", timeout: S.timeouts.dialogo });
  } catch (_) {
    log.info(`${prefisso}nessuna finestra di scelta: si apre direttamente`);
    return false;
  }

  for (const re of S.dialogoScelte) {
    const scelta = dialogo
      .locator('button, [role="button"], [role="radio"], label')
      .filter({ hasText: re })
      .first();
    if ((await scelta.count().catch(() => 0)) > 0) {
      const testo = (await scelta.innerText().catch(() => "")).trim();
      log.info(`${prefisso}finestra di scelta: clicco "${testo.slice(0, 60)}"`);
      await hm.click(page, scelta);
      return true;
    }
  }

  log.warn(
    `${prefisso}finestra di scelta comparsa ma nessuna opzione riconosciuta. ` +
      "Se serve, aggiungi il testo giusto in 'studio.dialogoScelte' " +
      "(src/lib/suno-selectors.js)."
  );
  return false;
}

/** Siamo dentro Studio? (URL riconoscibile oppure un marcatore in pagina) */
async function inStudio(page) {
  const url = page.url();
  if (S.urlFragments.some((f) => url.includes(f))) return true;
  for (const m of S.markers) {
    const n = await page
      .locator(m)
      .locator("visible=true")
      .count()
      .catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

/**
 * Percorso completo: riga del brano in /create -> (…) -> Edit -> Open in Studio.
 *
 * @param {import('playwright').Page} page pagina gia' su /create
 * @param {object} opts { songId, titolo, prefisso }
 * @returns {Promise<{page: import('playwright').Page, url: string}>}
 */
async function apriInStudioDaCreate(page, opts = {}) {
  const p = opts.prefisso || "   ";
  const context = page.context();

  // La finestra deve essere davanti: se e' dietro ad altre, Chrome rallenta la
  // pagina e Studio non finisce mai di caricare.
  await page.bringToFront().catch(() => {});

  // --- 1) la riga del brano ---
  const trovata = await trovaRigaBrano(page, opts);
  if (!trovata) {
    throw new Error(
      "brano non trovato nella lista di /create " +
        `(id: ${opts.songId || "-"}, titolo: ${opts.titolo || "-"}). ` +
        "Scorri la pagina o passa un brano presente nella lista."
    );
  }
  log.info(`${p}riga del brano trovata (menu: '${trovata.selettore}')`);

  // Passare sopra la riga fa comparire il bottone (…), che spesso e' nascosto
  // finche' non ci sei sopra col mouse.
  await hm.hover(page, trovata.riga, { dwell: 350 });

  // --- 2) apri il menu (…) di QUELLA riga ---
  await hm.click(page, trovata.bottone);
  const menu = await attendiMenu(page, 1, S.timeouts.menu);
  if (!menu) {
    throw new Error(
      "il menu (…) del brano non si e' aperto. Se Suno ha cambiato interfaccia, " +
        "aggiorna 'studio.moreMenuButton' in src/lib/suno-selectors.js"
    );
  }
  log.info(`${p}voci del menu: ${JSON.stringify(await vociDi(menu))}`);

  // --- 3) Edit: si apre AL PASSAGGIO del mouse, non col click ---
  const edit = vocePerTesto(menu, S.voceEdit);
  if ((await edit.count().catch(() => 0)) === 0) {
    throw new Error(
      `voce '${S.voceEdit}' assente dal menu del brano. Voci viste: ` +
        JSON.stringify(await vociDi(menu))
    );
  }
  await hm.hover(page, edit, { dwell: 500 });

  let sottomenu = await attendiMenu(page, 2, S.timeouts.sottomenu);
  if (!sottomenu) {
    // Alcune versioni aprono il sottomenu solo al click: proviamo anche cosi'.
    await hm.click(page, edit);
    sottomenu = await attendiMenu(page, 2, S.timeouts.sottomenu);
  }
  if (!sottomenu) {
    throw new Error(
      `il sottomenu di '${S.voceEdit}' non si e' aperto (ne' con l'hover ne' col click).`
    );
  }
  log.info(`${p}voci del sottomenu: ${JSON.stringify(await vociDi(sottomenu))}`);

  // --- 4) Open in Studio ---
  const voce = vocePerTesto(sottomenu, S.voceOpenInStudio);
  if ((await voce.count().catch(() => 0)) === 0) {
    throw new Error(
      `voce '${S.voceOpenInStudio}' assente dal sottomenu. Voci viste: ` +
        JSON.stringify(await vociDi(sottomenu))
    );
  }

  // Entra nel pannello del sottomenu senza farlo richiudere, poi clicca.
  await entraNelSottomenu(page, sottomenu, voce);
  await hm.hover(page, voce, { dwell: 250 });

  // Studio puo' aprirsi in una scheda nuova: registro le nuove schede senza
  // METTERMI AD ASPETTARLE. Aspettare con waitForEvent('page') costa il timeout
  // intero (10-15 secondi buttati) ogni volta che Studio si apre invece nella
  // stessa scheda, che e' il caso normale.
  const nuovePagine = [];
  const onPage = (nuova) => nuovePagine.push(nuova);
  context.on("page", onPage);

  let target = page;
  try {
    await hm.click(page, voce);
    log.info(`${p}cliccato '${S.voceOpenInStudio}'`);

    // --- 5) attesa ATTIVA: un unico giro che controlla TUTTO insieme ---
    // Scheda nuova, finestra di scelta e caricamento non sono passaggi in fila
    // con un timeout ciascuno: qui si controllano a ogni giro e si esce appena
    // Studio e' pronto. Nel frattempo il puntatore si muove di pochi pixel e la
    // finestra resta davanti: e' quello che facevi tu a mano per sbloccarla.
    log.info(`${p}attendo Studio (tengo la pagina attiva)`);
    let dialogoVisto = false;

    const ok = await hm.attesaAttiva(
      page,
      S.timeouts.caricamento,
      async () => {
        // a) Studio si e' aperto in una scheda nuova?
        if (target === page && nuovePagine.length > 0) {
          target = nuovePagine[0];
          log.info(`${p}Studio si e' aperto in una NUOVA scheda`);
          await target.bringToFront().catch(() => {});
        }
        // b) ci siamo?
        if (await inStudio(target)) return true;
        // c) e' comparsa la finestra di scelta? (una volta sola)
        if (!dialogoVisto) {
          const d = target.locator(S.dialogo).locator("visible=true").first();
          if ((await d.count().catch(() => 0)) > 0) {
            dialogoVisto = true;
            await gestisciDialogo(target, p);
          }
        }
        return false;
      },
      { pagina: () => target }
    );

    if (!ok) {
      throw new Error(
        `Studio non si e' aperto entro ${Math.round(
          S.timeouts.caricamento / 1000
        )}s. Ultima pagina: ${target.url()}`
      );
    }
  } finally {
    context.off("page", onPage);
  }

  log.info(`${p}Studio aperto: ${target.url()}`);
  return { page: target, url: target.url() };
}

module.exports = {
  elencaBrani,
  trovaRigaBrano,
  apriInStudioDaCreate,
  attendiMenu,
  vociDi,
  vocePerTesto,
  inStudio,
  gestisciDialogo,
  escapeRe,
  xpathPredicato,
};
