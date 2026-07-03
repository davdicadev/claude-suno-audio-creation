# Suno Audio Automation

Automazione **locale** che, partendo da prompt per Suno AI:

1. **genera** i brani sul sito di Suno tramite automazione del browser (Playwright, niente API a pagamento);
2. **scarica** i brani in 3 cartelle — **A** (primo brano di ogni generazione), **B** (secondo brano), **C** (brani singoli / riserva);
3. **riscrive i titoli** con le **API di Claude**, producendo titoli unici ottimizzati sulle parole chiave del canale;
4. **monta** ogni playlist in un unico MP3 con **FFMPEG**, in ordine alfabetico;
5. genera una **tracklist** con titolo + timestamp per ogni playlist.

Gestisce **più canali YouTube** da un **unico file di configurazione**: con un solo avvio produce la parte audio di tutti i progetti.

---

## Come funziona (in breve)

```
projects.json ──▶ 1. Suno (Playwright)  ──▶ cartella-A / cartella-B / cartella-C  + manifest.json
                  2. Claude (titoli)     ──▶ file rinominati (nome sicuro) + titolo display nel manifest
                  3. FFMPEG (montaggio)  ──▶ export/*.mp3  +  tracklist/*.txt
```

Le tre fasi sono tre script indipendenti in `src/`, orchestrati da `src/run.js` **oppure** dal workflow n8n in `n8n/suno-audio-automation.json`.

---

## Requisiti

- **Node.js 18+** (`node -v`)
- **FFMPEG** e **ffprobe** nel PATH (o percorsi indicati in config). Su Windows con Scoop: `scoop install ffmpeg`
- **n8n** installato in locale (opzionale, per orchestrare da interfaccia)
- Un **account Suno** con cui fai il login una volta
- Una **API key di Claude** (vedi sotto)

---

## 1. Installazione

```bash
git clone <questo-repo> suno-audio-automation
cd suno-audio-automation
npm install
```

`npm install` scarica anche il browser Chromium usato da Playwright (se non presente).

---

## 2. Account Claude, API key e credito

La riscrittura dei titoli usa le API di Claude. Serve un account **separato** da claude.ai.

1. **Crea l'account API**: vai su **https://console.anthropic.com** e registrati.
2. **Aggiungi credito**: menu **Billing → Add credits**. Minimo **5 USD** (bastano per moltissimo tempo, vedi costi).
3. **Genera la chiave**: menu **API Keys → Create Key**, dai un nome (es. `n8n-suno`). **Copiala subito**: viene mostrata una sola volta.

### Costi reali

La riscrittura di un titolo è un compito minuscolo. Con il modello di default **Claude Haiku 4.5** ($1 / milione di token in input, $5 in output):

| Brani | Costo circa |
|------:|:-----------|
| 100 | ~0,03–0,04 USD |
| 1.000 | < 0,40 USD |

In pratica i 5 USD iniziali bastano per **decine di migliaia** di titoli.

### Imposta la chiave come variabile d'ambiente

Gli script leggono `ANTHROPIC_API_KEY` dall'ambiente (così la chiave non finisce mai dentro i file o i workflow).

**Windows (PowerShell, permanente per l'utente):**
```powershell
setx ANTHROPIC_API_KEY "sk-ant-..."
```
Poi **chiudi e riapri** il terminale (e riavvia n8n) perché la variabile venga letta.

**Verifica:**
```powershell
echo $env:ANTHROPIC_API_KEY
```

> Se lanci le fasi da n8n, la variabile deve essere impostata nell'ambiente in cui **gira n8n**.

---

## 3. Primo login a Suno (una volta sola per account)

> Tutti i comandi `node src/...` vanno eseguiti **dalla cartella del progetto** (dove c'è `package.json`).

> **Prima del login crea il file di configurazione** (il login lo legge per sapere dove salvare la sessione): `cp config/projects.example.json config/projects.json` (Windows: `copy config\projects.example.json config\projects.json`).

Usiamo un **profilo browser persistente**: fai il login a mano una volta, poi l'automazione riusa la sessione.

```bash
npm run login
# oppure: node src/suno.js --login-only
```

Si apre una finestra di Chrome su Suno: **accedi** (Google/Discord/email). Quando vedi la tua libreria, torna al terminale e premi **INVIO**. La sessione resta salvata in `<baseDir>/browser-profiles/default/`.

### Più account Suno

Puoi usare **account Suno diversi per progetti diversi**, anche nella stessa esecuzione. Ogni account = un **profilo** con un nome. Fai il login una volta per ciascuno:

```bash
node src/suno.js --login-only --profile default
node src/suno.js --login-only --profile account-2
```

Poi nel progetto indichi quale account usare col campo `sunoProfilo` (vedi sotto). I progetti vengono elaborati **in sequenza**: quando l'automazione passa a un progetto con un account diverso, chiude il browser e ne apre uno con il profilo giusto. Progetti che usano lo stesso account non riaprono il browser.

> Nota: gli account vengono usati **uno alla volta** (non in parallelo). Questo è anche il comportamento voluto, per non sovraccaricare Suno.

---

## 4. Configurazione dei progetti

Copia l'esempio e adattalo:

```bash
cp config/projects.example.json config/projects.json
```

Struttura (un blocco per canale YouTube):

```jsonc
{
  "baseDir": "C:\\n8n\\suno",          // cartella radice dove finisce tutto l'output
  "ffmpegPath": "ffmpeg",              // o percorso completo a ffmpeg.exe
  "ffprobePath": "ffprobe",            // o percorso completo a ffprobe.exe
  "sunoUrl": "https://suno.com",
  "maxGenerazioniPerBatch": 10,        // generazioni per lotto (max 10, vedi sotto)

  "progetti": [
    {
      "nome": "canale-lofi",           // diventa la sottocartella dell'output
      "attivo": true,                  // false = salta questo progetto
      "sunoProfilo": "default",        // account Suno da usare (vedi "Più account")
      "keywordsTitoli": ["lofi", "study beats", "relax"],  // guidano i titoli di Claude
      "prompts": [
        { "testo": "warm lofi hip hop, rainy night", "strumentale": true },
        { "testo": "jazzy lofi, coffee shop vibes",   "strumentale": false }
      ],
      "playlist": {
        "daA": 2,                      // quante playlist pescano dalla cartella A
        "daB": 2,                      // quante playlist pescano dalla cartella B
        "braniPerPlaylist": 50         // N brani per playlist
      },
      "margineGenerazione": 0.15,      // 15% di brani in più per sicurezza (riserva C)
      "maxGenerazioniPerBatch": 10     // opzionale: override del valore globale
    }
  ]
}
```

- **strumentale**: per ogni prompt scegli se il brano è strumentale (`true`) o cantato (`false`).
- **daA / daB**: possono anche essere diversi (es. 3 e 1).
- **sunoProfilo**: quale account Suno usare (vedi sezione "Più account Suno"). Se omesso, usa `default`.

### Download a lotti

Le generazioni non vengono lanciate tutte insieme: l'automazione procede a **lotti** di `maxGenerazioniPerBatch` (default **10**, il massimo che Suno elabora in contemporanea, ~20 brani). Per ogni lotto: **lancia** le generazioni → **attende** il completamento → **scarica** i brani → passa al lotto successivo. Così Suno non viene sovraccaricato e i brani vengono salvati progressivamente (se qualcosa si interrompe, i lotti già scaricati restano). Lo smistamento A/B usa le **coppie reali** restituite da ogni generazione (1° brano → A, 2° → B; generazione singola → C).

### Quanti brani vengono generati?

Ogni click su Suno genera 2 brani: il 1° va in **A**, il 2° in **B**. Quindi un click riempie insieme un posto in A e uno in B.

- click necessari = `max(daA, daB) × braniPerPlaylist`
- si aggiunge il **margine** (default 15%) per coprire le coppie non formate; quei brani "spaiati" finiscono in **C**.
- la cartella **C** serve solo a **tappare i buchi**: se in A (o B) mancano brani per completare le playlist, vengono presi da C.

**Esempio** (il tuo caso): 4 playlist da 50 = 2 da A + 2 da B → servono 100 in A e 100 in B → **100 click** base → **115** con il margine del 15%. Se A si ferma a 98, la fase di montaggio prende 2 brani da C per arrivare a 100.

---

## 5. Esecuzione

### Da riga di comando

```bash
# tutte le fasi, tutti i progetti attivi
npm run run
# oppure: node src/run.js

# un solo progetto
node src/run.js --project canale-lofi

# una sola fase
node src/run.js --phase titles
node src/run.js --phase generate,playlists
```

Singole fasi:

```bash
node src/suno.js            # 1. genera + scarica in A/B/C
node src/rewrite-titles.js  # 2. riscrive titoli con Claude + rinomina
node src/build-playlists.js # 3. monta playlist + tracklist
```

Opzioni utili:
- `node src/rewrite-titles.js --dry-run` — mostra i nuovi titoli senza rinominare
- `node src/build-playlists.js --reencode` — ricodifica invece di copiare (se il montaggio "copy" fallisce)

### Da n8n

1. Importa `n8n/suno-audio-automation.json` in n8n.
2. Nel nodo **Impostazioni** metti `repoDir` (la cartella di questo progetto) e `configPath` (il tuo `projects.json`).
3. Assicurati che `ANTHROPIC_API_KEY` sia nell'ambiente in cui gira n8n.
4. Esegui: il workflow lancia in sequenza le 3 fasi per **tutti** i progetti attivi.

---

## 6. Struttura dell'output

```
<baseDir>\
  browser-profiles\                 (un profilo/sessione per account Suno)
    default\  account-2\ ...
  <nome-progetto>\
    cartella-A\  cartella-B\  cartella-C\   (MP3 scaricati, rinominati)
    manifest.json                    (elenco brani: id, cartella, titoli)
    export\
      playlist_A_1.mp3  playlist_A_2.mp3  playlist_B_1.mp3 ...
    tracklist\
      playlist_A_1.txt  ...          (titolo + timestamp per YouTube)
```

---

## Caratteri speciali: com'è risolto

Il problema del tuo vecchio workflow (apostrofi, accenti, parentesi che rompono PowerShell/FFMPEG) è risolto con la strategia **doppia versione**:

- il **nome file** su disco è **sicuro** (solo lettere ASCII, numeri, spazi, trattini) → FFMPEG e PowerShell non si rompono mai;
- il **titolo "bello"** (con eventuali caratteri speciali) è tenuto a parte nel manifest e usato **solo nella tracklist** per YouTube.

Esempio: il titolo `Dreamin' in Rio (café)` diventa il file `Dreamin in Rio cafe.mp3`, mentre nella tracklist resta leggibile.

---

## Se Suno cambia interfaccia

La generazione e il download dipendono da alcuni selettori della pagina Suno. Se qualcosa smette di funzionare, quasi sempre basta aggiornare **un** selettore in **`src/lib/suno-selectors.js`** (campo prompt, toggle strumentale, bottone Create). Non serve toccare la logica.

---

## Note

- La generazione apre un **browser visibile** (serve per Suno). Tienilo aperto durante l'esecuzione.
- Se il credito Claude finisce, la fase titoli si ferma con un errore chiaro: ricarica e rilancia solo quella fase (`node src/run.js --phase titles,playlists`).
- Il download usa la **sessione autenticata del browser**, non API con chiavi.
