"use strict";

/**
 * Selettori e parametri della UI di Suno.
 *
 * IMPORTANTE: Suno cambia spesso l'interfaccia. Se la generazione o il download
 * smettono di funzionare, quasi sempre basta aggiornare UNO di questi selettori.
 * Sono raccolti qui apposta, tutti in un punto solo, cosi non devi toccare la
 * logica dello script.
 *
 * Come trovare un selettore: apri Suno in Chrome, tasto destro sull'elemento ->
 * "Ispeziona", guarda attributi come placeholder, aria-label, data-testid.
 * Preferisci selettori stabili (placeholder/aria-label/testo) agli id casuali.
 */

module.exports = {
  // Pagina di creazione brani.
  createUrl: "/create",

  // Campo del prompt (modalita semplice). Diversi fallback provati in ordine.
  promptTextarea: [
    'textarea[placeholder*="song" i]',
    'textarea[placeholder*="describe" i]',
    'textarea[data-testid*="prompt" i]',
    'textarea[aria-label*="prompt" i]',
    "textarea",
  ],

  // Toggle "Instrumental" (strumentale). Su Suno e' un bottone con il testo
  // "Instrumental" e un pallino che si accende quando e' attivo.
  instrumentalToggle: [
    'button[aria-label*="instrumental" i]',
    'input[type="checkbox"][name*="instrumental" i]',
    'button:has-text("Instrumental")',
    'div[role="switch"]:near(:text("Instrumental"))',
    'label:has-text("Instrumental")',
  ],

  // Bottone che avvia la generazione. Su Suno ha aria-label "Create song".
  createButton: [
    'button[aria-label="Create song"]',
    'button[aria-label*="create song" i]',
    'button[aria-label*="create" i]',
    'button:has-text("Create")',
    'button[data-testid*="create" i]',
    'button:has-text("Generate")',
  ],

  // --- Studio (apertura di un brano nell'editor multitraccia) ---
  // Tutto quello che serve per il percorso: riga del brano nella pagina /create
  // -> menu (…) -> Edit -> Open in Studio. I nomi delle voci sono quelli che
  // Suno mostra davvero (in inglese, anche con interfaccia in italiano).
  studio: {
    // Il bottone (…) di UNA riga della lista brani. Lo cerchiamo SEMPRE dentro
    // la riga del brano, mai "il primo della pagina": in /create ce ne sono
    // decine (uno per brano, piu' quelli della barra laterale).
    moreMenuButton: [
      'button[aria-label="More menu contents"]',
      'button[aria-label*="more menu" i]',
      'button[aria-haspopup="menu"]',
    ],

    // Contenitore del menu aperto e sue voci (Radix UI usa i ruoli ARIA).
    menuContainer: '[role="menu"], [data-radix-menu-content]',
    menuItem: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',

    // Voci da attraversare. 'Edit' apre un SOTTOMENU (non naviga).
    voceEdit: "Edit",
    voceOpenInStudio: "Open in Studio",

    // Finestra che a volte chiede come importare il brano in Studio.
    dialogo: '[role="dialog"], [role="alertdialog"]',
    // Prima scelta utile: traccia singola / mix completo (0 crediti).
    dialogoScelte: [
      /use the full mix/i,
      /single[\s-]?track/i,
      /full mix/i,
      /continue|continua|conferma|confirm/i,
    ],

    // Come capiamo di essere DENTRO Studio.
    urlFragments: ["/studio", "studio.suno.com"],
    // Marcatori di riserva, se l'URL non cambiasse in modo riconoscibile.
    markers: [
      '[data-testid*="studio" i]',
      '[class*="timeline" i]',
      '[aria-label*="timeline" i]',
    ],

    timeouts: {
      menu: 8000, // apertura del menu (…)
      sottomenu: 8000, // apertura del sottomenu Edit
      dialogo: 6000, // comparsa della finestra di scelta
      caricamento: 180000, // caricamento di Studio (e' pesante)
    },
  },

  // Endpoint interni che la pagina stessa chiama e da cui leggiamo i brani.
  // NON sono chiamate ad API con chiavi: sono le risposte che il browser gia
  // riceve durante la navigazione autenticata. Le intercettiamo e basta.
  feedUrlFragments: ["/api/feed", "/api/clips", "/api/project", "/api/session"],
  generateUrlFragments: ["/api/generate", "/api/generate/v2", "/api/create"],

  // Attese (ms).
  timeouts: {
    navigation: 60000,
    afterCreateClick: 2500, // pausa tra un click "Create" e il successivo
    pollInterval: 15000, // ogni quanto ricontrollare la libreria
    pollMaxPerBatch: 15 * 60 * 1000, // attesa massima per completare UN lotto
    loginWait: 10 * 60 * 1000, // tempo per fare il login manuale
    captchaWait: 5 * 60 * 1000, // tempo max per risolvere a mano un captcha
  },
};
