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
      // La durata (es. "2:57") serve dopo: e' il segnale piu' preciso per
      // capire che il brano e' stato caricato dentro Studio.
      const riga = a.closest('[role="row"], li, tr, div');
      const testoRiga = riga ? riga.innerText || "" : "";
      const d = testoRiga.match(/\b(\d{1,2}:[0-5]\d)\b/);
      out.push({
        id: m[1],
        titolo: testo.slice(0, 80) || "(senza titolo)",
        durata: d ? d[1] : null,
      });
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

/* ------------------------------------------------------------------ *
 * "Il brano e' DAVVERO caricato?"
 *
 * Il bottone Export compare quasi subito, ma in quel momento la traccia non
 * c'e' ancora: esportare li' darebbe un file sbagliato o vuoto. Serve quindi un
 * cancello separato da inStudio() (che dice solo "siamo arrivati sulla pagina").
 *
 * PERCHE' NON "aspetta che la pagina sia caricata" (networkidle) E BASTA
 * Studio e' un'applicazione a pagina singola: il documento risulta "caricato"
 * quasi subito, mentre il brano arriva DOPO. E nel frattempo restano aperte
 * connessioni di servizio (telemetria, stream) che non finiscono mai: aspettare
 * "zero richieste" o non basta o non succede mai.
 *
 * PERCHE' NON UN TEMPO FISSO
 * Un'attesa a tempo e' sempre sbagliata da una delle due parti: troppo corta
 * quando la rete e' lenta o il brano e' lungo, e tempo buttato quando invece e'
 * veloce. Serve solo come RETE DI SICUREZZA, non come criterio.
 *
 * COSA GUARDIAMO QUINDI
 *  - un segnale di CONTENUTO: l'audio e' decodificato, oppure la forma d'onda
 *    e' stata disegnata, oppure compare la durata attesa del brano. E' la prova
 *    che la traccia e' dentro l'editor;
 *  - la RETE ferma da qualche secondo (ignorando telemetria e stream);
 * e pretendiamo che reggano INSIEME per qualche secondo di fila, cosi' un
 * attimo di quiete a meta' caricamento non ci inganna.
 * ------------------------------------------------------------------ */

const P = () => S.pronto;

/**
 * Tiene il conto delle richieste di rete ancora in volo. Le richieste "vecchie"
 * (stream, long-poll) e quelle di servizio non contano: altrimenti la rete non
 * risulterebbe MAI ferma e resteremmo ad aspettare per sempre.
 */
function tracciaRete(page) {
  const inVolo = new Map(); // richiesta -> quando e' partita
  let ultimoEvento = Date.now();

  const daIgnorare = (req) => {
    const url = req.url();
    return P().ignoraRete.some((f) => url.includes(f));
  };

  const parte = (req) => {
    if (daIgnorare(req)) return;
    inVolo.set(req, Date.now());
    ultimoEvento = Date.now();
  };

  const finisce = (req) => {
    if (daIgnorare(req)) return;
    inVolo.delete(req);
    // ATTENZIONE: aggiorniamo l'orologio anche per richieste che non stavamo
    // seguendo. Il download pesante dell'audio parte spesso PRIMA che iniziamo
    // ad ascoltare (cioe' al momento della navigazione): senza questa riga la
    // sua conclusione passerebbe inosservata e la rete sembrerebbe "ferma"
    // mentre il brano si sta ancora scaricando.
    ultimoEvento = Date.now();
  };

  page.on("request", parte);
  page.on("requestfinished", finisce);
  page.on("requestfailed", finisce);

  return {
    stato() {
      const ora = Date.now();
      let attive = 0;
      for (const [req, t] of inVolo) {
        if (ora - t > P().richiestaVecchiaMs) inVolo.delete(req);
        else attive++;
      }
      return { attive, fermaDa: ora - ultimoEvento };
    },
    ferma() {
      const s = this.stato();
      return s.attive === 0 && s.fermaDa >= P().reteFermaMs;
    },
    stop() {
      page.off("request", parte);
      page.off("requestfinished", finisce);
      page.off("requestfailed", finisce);
    },
  };
}

/**
 * Segnali di CONTENUTO letti dentro la pagina: e' la parte che dice davvero
 * "il brano c'e'". Nessuno dei tre e' garantito su ogni versione di Studio,
 * quindi ne basta uno e li registriamo tutti nel log.
 */
async function segnaliContenuto(page, durataAttesa) {
  return page
    .evaluate((durata) => {
      // a) elementi audio/video con dati decodificati o durata nota
      const media = Array.from(document.querySelectorAll("audio, video"));
      const audioPronti = media.filter(
        (m) => m.readyState >= 2 || (Number.isFinite(m.duration) && m.duration > 0)
      ).length;

      // b) forma d'onda disegnata: un canvas che non e' piu' vuoto
      let canvasTotali = 0;
      let canvasDisegnati = 0;
      for (const c of document.querySelectorAll("canvas")) {
        if (c.width < 40 || c.height < 8) continue;
        canvasTotali++;
        try {
          const ctx = c.getContext("2d");
          if (!ctx) continue; // WebGL: non leggibile da qui
          const larghezza = Math.min(c.width, 400);
          const dati = ctx.getImageData(0, 0, larghezza, c.height).data;
          // campiona un pixel ogni 7 per non appesantire
          let pieni = 0;
          let letti = 0;
          for (let i = 3; i < dati.length; i += 4 * 7) {
            letti++;
            if (dati[i] > 8) pieni++;
          }
          if (letti > 0 && pieni / letti > 0.02) canvasDisegnati++;
        } catch (_) {
          /* canvas non leggibile: lo ignoriamo */
        }
      }

      // c) la durata attesa del brano compare in pagina (es. "2:57")
      const testo = document.body ? document.body.innerText || "" : "";
      const durataVisibile = !!durata && testo.includes(durata);

      return {
        audioPronti,
        mediaTotali: media.length,
        canvasTotali,
        canvasDisegnati,
        durataVisibile,
      };
    }, durataAttesa || null)
    .catch(() => ({
      audioPronti: 0,
      mediaTotali: 0,
      canvasTotali: 0,
      canvasDisegnati: 0,
      durataVisibile: false,
    }));
}

/** Stato del bottone Export: presente? attivo? (solo informativo) */
async function statoExport(page) {
  for (const sel of P().exportButton) {
    const b = page.locator(sel).locator("visible=true").first();
    if ((await b.count().catch(() => 0)) > 0) {
      const disabilitato = await b.isDisabled().catch(() => null);
      return { presente: true, attivo: disabilitato === false, selettore: sel };
    }
  }
  return { presente: false, attivo: false, selettore: null };
}

/**
 * Aspetta che il BRANO sia caricato dentro Studio, non solo che la pagina si
 * sia aperta. Da chiamare PRIMA dell'export.
 *
 * @param {object} opts { durata: "2:57", prefisso, timeout }
 * @returns {Promise<object>} il rapporto sui segnali (utile nel log)
 */
async function attendiBranoCaricato(page, opts = {}) {
  const p = opts.prefisso || "   ";
  const timeout = opts.timeout || P().timeout;
  const rete = tracciaRete(page);
  const inizio = Date.now();
  let stabileDa = null;
  let ultimoLog = 0;
  let ultimo = null;

  log.info(`${p}attendo che il BRANO sia caricato in Studio (non solo la pagina)`);

  try {
    const ok = await hm.attesaAttiva(page, timeout, async () => {
      const c = await segnaliContenuto(page, opts.durata);
      const r = rete.stato();
      const exp = await statoExport(page);

      const contenuto =
        c.audioPronti > 0 || c.canvasDisegnati > 0 || c.durataVisibile;
      const pronto = contenuto && rete.ferma();

      if (pronto) {
        if (!stabileDa) stabileDa = Date.now();
      } else {
        stabileDa = null;
      }

      ultimo = { ...c, ...exp, rete: r, stabileDa };

      // Un rigo di log ogni ~2s: la prima volta che gira su Suno vero, e' qui
      // che si legge quali segnali esistono davvero e quali no.
      if (Date.now() - ultimoLog > 2000) {
        ultimoLog = Date.now();
        log.info(
          `${p}  audio ${c.audioPronti}/${c.mediaTotali} | ` +
            `canvas disegnati ${c.canvasDisegnati}/${c.canvasTotali} | ` +
            `durata attesa ${c.durataVisibile ? "sì" : "no"} | ` +
            `rete ${r.attive} in volo, ferma da ${(r.fermaDa / 1000).toFixed(1)}s | ` +
            `Export ${exp.presente ? (exp.attivo ? "attivo" : "disattivo") : "assente"}`
        );
      }

      return (
        !!stabileDa &&
        Date.now() - stabileDa >= P().finestraStabile &&
        Date.now() - inizio >= P().attesaMinima
      );
    });

    const secondi = ((Date.now() - inizio) / 1000).toFixed(1);
    if (!ok) {
      // Rete di sicurezza: non blocchiamo il lavoro, ma lo diciamo forte.
      log.warn(
        `${p}il brano non risulta caricato dopo ${secondi}s: procedo comunque, ` +
          "ma l'export potrebbe essere incompleto. Ultimi segnali: " +
          JSON.stringify(ultimo)
      );
      return { pronto: false, secondi: Number(secondi), segnali: ultimo };
    }

    log.info(`${p}brano caricato in Studio dopo ${secondi}s: si può esportare`);
    return { pronto: true, secondi: Number(secondi), segnali: ultimo };
  } finally {
    rete.stop();
  }
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

  // --- 6) il brano e' DENTRO? ---
  // Essere sulla pagina di Studio non basta: il bottone Export e' gia' li',
  // ma la traccia non e' ancora caricata. Chi chiama non deve ricordarsi di
  // aspettare: l'attesa e' parte dell'apertura.
  let caricamento = null;
  if (opts.attendiBrano !== false) {
    caricamento = await attendiBranoCaricato(target, {
      durata: opts.durata,
      prefisso: p,
    });
  }

  log.info(`${p}Studio aperto: ${target.url()}`);
  return { page: target, url: target.url(), caricamento };
}

module.exports = {
  elencaBrani,
  trovaRigaBrano,
  apriInStudioDaCreate,
  attendiBranoCaricato,
  segnaliContenuto,
  statoExport,
  tracciaRete,
  attendiMenu,
  vociDi,
  vocePerTesto,
  inStudio,
  gestisciDialogo,
  escapeRe,
  xpathPredicato,
};
