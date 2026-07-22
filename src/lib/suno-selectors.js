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
  },
};
