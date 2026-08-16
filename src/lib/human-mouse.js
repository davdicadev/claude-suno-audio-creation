"use strict";

/**
 * Mouse "virtuale" che si comporta come quello vero.
 *
 * PERCHE' SERVE
 * Quando muovi il mouse FISICAMENTE sopra la finestra, l'automazione riesce ad
 * aprire Studio; se non lo tocchi, resta ferma. I motivi sono due, e questo
 * modulo li risolve entrambi:
 *
 *  1) I menu di Suno (libreria Radix UI) si aprono e restano aperti in base al
 *     PASSAGGIO del puntatore: ascoltano pointermove/pointerover, non solo il
 *     click. In piu' i sottomenu decidono se restare aperti guardando DOVE sta
 *     andando il puntatore: se questo SALTA da un punto all'altro (com'e' un
 *     click di Playwright, che teletrasporta il mouse) il sottomenu puo'
 *     richiudersi prima che il click arrivi. Muovendosi a piccoli passi,
 *     invece, il percorso esiste davvero e il menu resta aperto.
 *
 *  2) Chrome mette in "pausa" le pagine di una finestra che non riceve
 *     attivita' (rendering e timer rallentati). Studio e' pesante: se la pagina
 *     e' rallentata non finisce mai di caricare. Qualche micro-movimento
 *     durante l'attesa la tiene sveglia esattamente come facevi tu a mano.
 *
 * Nota: NON e' un trucco per aggirare i captcha. Sono gli stessi eventi che
 * Playwright manda gia' (input reali del browser), solo distribuiti nel tempo e
 * lungo un percorso, invece che tutti in un punto solo.
 */

function rnd(min, max) {
  return min + Math.random() * (max - min);
}

function rndInt(min, max) {
  return Math.round(rnd(min, max));
}

/** Ultima posizione nota del puntatore su questa pagina. */
function posizione(page) {
  return page.__mouseXY || { x: 8, y: 8 };
}

function ricorda(page, x, y) {
  page.__mouseXY = { x, y };
}

/**
 * Punto casuale "umano" dentro un rettangolo: vicino al centro, mai sul bordo
 * (sul bordo il click rischia di finire sull'elemento accanto).
 */
function puntoDentro(box) {
  const dx = (box.width / 2) * 0.45;
  const dy = (box.height / 2) * 0.45;
  return {
    x: box.x + box.width / 2 + rnd(-dx, dx),
    y: box.y + box.height / 2 + rnd(-dy, dy),
  };
}

/**
 * Sposta il puntatore fino a (x, y) lungo una CURVA, a piccoli passi e con
 * micro-pause: e' questa la differenza con il click normale di Playwright, che
 * invece teletrasporta il mouse sulla destinazione.
 */
async function muovi(page, x, y, opts = {}) {
  const da = posizione(page);
  const dist = Math.hypot(x - da.x, y - da.y);
  const passi = opts.passi || Math.max(6, Math.min(40, Math.round(dist / 12)));

  // Punto di controllo spostato di lato: la traiettoria diventa un arco, non
  // una retta perfetta (una retta perfetta non la fa nessuna mano umana).
  const curva = opts.curva != null ? opts.curva : 0.12;
  const cx = (da.x + x) / 2 + rnd(-dist * curva, dist * curva);
  const cy = (da.y + y) / 2 + rnd(-dist * curva, dist * curva);

  for (let i = 1; i <= passi; i++) {
    const t = i / passi;
    const u = 1 - t;
    const px = u * u * da.x + 2 * u * t * cx + t * t * x;
    const py = u * u * da.y + 2 * u * t * cy + t * t * y;
    await page.mouse.move(px, py);
    if (i % 3 === 0) await page.waitForTimeout(rndInt(4, 16));
  }
  await page.mouse.move(x, y);
  ricorda(page, x, y);
}

/** Passa per una serie di punti (serve per "entrare" nei sottomenu). */
async function muoviLungo(page, punti, opts = {}) {
  for (const p of punti) {
    await muovi(page, p.x, p.y, opts);
    await page.waitForTimeout(rndInt(40, 120));
  }
}

/** Rettangolo dell'elemento, dopo averlo portato in vista. */
async function box(locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const b = await locator.boundingBox();
  if (!b || b.width < 1 || b.height < 1) {
    throw new Error("elemento non visibile (nessun rettangolo su cui puntare)");
  }
  return b;
}

/**
 * Porta il puntatore SOPRA l'elemento e ci resta un attimo (dwell). E' la
 * mossa che apre i menu "al passaggio del mouse": senza la pausa, la UI non fa
 * in tempo a considerarlo un hover volontario.
 */
async function hover(page, locator, opts = {}) {
  const b = await box(locator);
  const p = opts.punto || puntoDentro(b);
  await muovi(page, p.x, p.y, opts);
  await page.waitForTimeout(opts.dwell != null ? opts.dwell : rndInt(140, 340));
  return b;
}

/**
 * Click "umano": prima ci arriva sopra muovendosi, poi preme e rilascia con una
 * pausa in mezzo. Da usare al posto di locator.click() ovunque ci siano menu.
 */
async function click(page, locator, opts = {}) {
  const b = await hover(page, locator, opts);
  await page.mouse.down();
  await page.waitForTimeout(rndInt(40, 110));
  await page.mouse.up();
  await page.waitForTimeout(opts.dopo != null ? opts.dopo : rndInt(160, 380));
  return b;
}

/**
 * Parcheggia il puntatore in un punto "neutro" della finestra (in basso al
 * centro): serve PRIMA delle attese lunghe, per non lasciarlo fermo sopra un
 * menu che si richiuderebbe o su un elemento che reagisce all'hover.
 */
async function parcheggia(page) {
  const vp = page.viewportSize() || { width: 1400, height: 900 };
  await muovi(page, vp.width / 2 + rnd(-60, 60), vp.height - rnd(40, 90));
}

/**
 * Attesa ATTIVA: invece di stare fermi, ogni tanto muove di pochi pixel il
 * puntatore e riporta la finestra in primo piano. E' esattamente quello che
 * facevi tu muovendo il mouse a mano: impedisce a Chrome di mettere in pausa la
 * pagina mentre Studio carica.
 *
 * @param {number} ms quanto attendere in totale
 * @param {function} [condizione] se ritorna true, l'attesa finisce prima
 * @param {object} [opts] opts.pagina() = quale pagina tenere sveglia, se
 *   durante l'attesa il lavoro si sposta su una scheda nuova
 * @returns {boolean} true se la condizione si e' avverata
 */
async function attesaAttiva(page, ms, condizione, opts = {}) {
  const fine = Date.now() + ms;
  const passo = opts.passo || 700;
  const bersaglio = () => (opts.pagina && opts.pagina()) || page;
  let ultimoFront = 0;
  await parcheggia(page).catch(() => {});

  while (Date.now() < fine) {
    if (condizione) {
      let ok = false;
      try {
        ok = await condizione();
      } catch (_) {
        /* la pagina potrebbe stare navigando: riprovo al giro dopo */
      }
      if (ok) return true;
    }

    // Micro-movimento: la pagina riceve pointermove e resta "attiva".
    const attiva = bersaglio();
    const p = posizione(attiva);
    await attiva.mouse
      .move(p.x + rnd(-7, 7), p.y + rnd(-7, 7))
      .catch(() => {});

    // Ogni ~10s riporta la finestra davanti: se finisce dietro ad altre,
    // Chrome la considera nascosta e ne rallenta il rendering.
    if (Date.now() - ultimoFront > 10000) {
      ultimoFront = Date.now();
      await attiva.bringToFront().catch(() => {});
    }

    await page.waitForTimeout(rndInt(passo * 0.6, passo * 1.4));
  }

  if (condizione) {
    try {
      return await condizione();
    } catch (_) {
      return false;
    }
  }
  return false;
}

/** Pausa di lunghezza variabile (le pause umane non sono mai identiche). */
async function pausa(page, min, max) {
  await page.waitForTimeout(rndInt(min, max != null ? max : min * 1.8));
}

module.exports = {
  rnd,
  rndInt,
  posizione,
  puntoDentro,
  box,
  muovi,
  muoviLungo,
  hover,
  click,
  parcheggia,
  attesaAttiva,
  pausa,
};
