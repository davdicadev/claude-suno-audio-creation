# Guida passo-passo (macOS) — dall'inizio alla prima esecuzione

Guida per installare l'automazione su Mac, con n8n già installato in locale. Comandi nel **Terminale** (shell **zsh**, quella di default su Mac). Dove trovi `TUONOME` sostituisci con il tuo utente Mac (scoprilo con `echo $HOME` → es. `/Users/david`).

> 📁 **Cartella del progetto:** `~/suno-audio-automation`
> Tutti i comandi `node ...` / `npm ...` / `git ...` vanno lanciati da lì.
> Primo comando in ogni sessione di Terminale:
> ```bash
> cd ~/suno-audio-automation
> ```

---

## Uso quotidiano (dopo il primo setup)

Una volta completato il setup, per far partire l'automazione bastano poche righe:

```bash
cd ~/suno-audio-automation     # 1. entra nella cartella del progetto (sempre)
git pull                       # 2. (consigliato) scarica gli aggiornamenti
open config/projects.json      # 3. (solo se vuoi cambiare prompt/numeri)
node src/run.js                # 4. avvia tutto (generazione -> titoli -> playlist)
```

Il resto della guida serve solo per il **primo** setup.

---

## Passo 0 — Prerequisiti (una volta sola)

Apri il Terminale e verifica cosa hai già:

```bash
node -v        # deve stampare v18 o superiore
git --version
ffmpeg -version
ffprobe -version
```

- **Homebrew** (gestore pacchetti Mac): se manca, installalo da https://brew.sh
- **Node.js**: se usi n8n ce l'hai già. Se manca: `brew install node`
- **Git**: se manca, `xcode-select --install` oppure `brew install git`
- **FFMPEG + ffprobe**: `brew install ffmpeg` (include entrambi)
- **Google Chrome**: consigliato installarlo (https://google.com/chrome). L'automazione usa Chrome per superare il blocco del login Google; se non c'è, usa il Chromium interno di Playwright.

---

## Passo 1 — Scarica il progetto

```bash
cd ~
git clone -b claude/n8n-suno-audio-automation-otag87 https://github.com/davdicadev/claude-suno-audio-creation.git suno-audio-automation
cd suno-audio-automation
```

---

## Passo 2 — Installa dipendenze e browser

```bash
npm install
npx playwright install chromium
```

---

## Passo 3 — Account Claude, credito e chiave API

1. Vai su **https://console.anthropic.com** e registrati.
2. **Billing → Add credits**: minimo **5 USD** (bastano per decine di migliaia di titoli).
3. **API Keys → Create Key**: dai un nome e **copia subito** la chiave (`sk-ant-...`).

Imposta la chiave come variabile d'ambiente permanente (zsh):

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-...la-tua-chiave..."' >> ~/.zshrc
source ~/.zshrc
```

Verifica:
```bash
echo $ANTHROPIC_API_KEY
```

> **Usi n8n?** n8n (soprattutto se avviato da Homebrew/launchd) **spesso non eredita** la variabile d'ambiente. La soluzione più semplice e sicura è mettere la chiave in un **file**: l'automazione lo legge da sola.
> ```bash
> echo 'sk-ant-...la-tua-chiave...' > ~/suno-audio-automation/config/anthropic-key.txt
> ```
> Il file `config/anthropic-key.txt` è già in `.gitignore` (non finisce mai su git). L'ordine di ricerca della chiave è: 1) variabile d'ambiente `ANTHROPIC_API_KEY`; 2) file `config/anthropic-key.txt`; 3) campo `"anthropicApiKey"` nel `projects.json`.

---

## Passo 4 — Configura i tuoi progetti

Crea il file di configurazione:
```bash
cp config/projects.example.json config/projects.json
open config/projects.json
```

Adatta i valori usando **percorsi Mac** (con `/`, non `\`). Esempio minimo (sostituisci `TUONOME`):

```jsonc
{
  "baseDir": "/Users/TUONOME/suno",
  "ffmpegPath": "ffmpeg",
  "ffprobePath": "ffprobe",
  "sunoUrl": "https://suno.com",
  "maxGenerazioniPerBatch": 10,
  "progetti": [
    {
      "nome": "canale-lofi",
      "attivo": true,
      "sunoProfilo": "default",
      "keywordsTitoli": ["lofi", "study beats", "relax"],
      "prompts": [
        { "testo": "warm lofi hip hop, rainy night", "strumentale": true }
      ],
      "playlist": { "daA": 1, "daB": 1, "braniPerPlaylist": 50 },
      "margineGenerazione": 0.15
    }
  ]
}
```

> `baseDir` è dove finisce tutto l'output: usa un percorso completo (JSON non espande `~`).

---

## Passo 5 — Login a Suno (una volta per account)

```bash
node src/suno.js --login-only
```

Si apre Chrome su Suno: **accedi** e, quando vedi la tua libreria, torna al Terminale e premi **INVIO**. La sessione resta salvata.

Per più account:
```bash
node src/suno.js --login-only --profile account-2
```

---

## Passo 6 — Prova con numeri piccoli (consigliato)

Nel `config/projects.json` metti valori piccoli (es. `daA:1, daB:1, braniPerPlaylist:2`) e lancia solo la generazione:

```bash
node src/suno.js
```

⚠️ **Captcha:** se durante la generazione compare un captcha, l'automazione **si mette in pausa** e scrive in Terminale di risolverlo a mano. Risolvilo nella finestra di Chrome: riparte da sola entro pochi secondi (hai fino a 5 minuti).

Se i 2 brani compaiono in `~/suno/canale-lofi/cartella-A|B`, funziona.

---

## Passo 7 — Esecuzione completa

Rimetti i numeri veri e lancia tutte le fasi:

```bash
node src/run.js
```

Genera + scarica → riscrive i titoli con Claude → monta le playlist con tracklist.

---

## Passo 8 — Importare in n8n (macOS)

1. Apri n8n (di solito `http://localhost:5678`) → **Workflows → Import from File** → scegli `~/suno-audio-automation/n8n/suno-audio-automation.json`.
2. Apri il nodo **Impostazioni** e imposta i percorsi Mac:
   - `repoDir` = `/Users/TUONOME/suno-audio-automation`
   - `configPath` = `/Users/TUONOME/suno-audio-automation/config/projects.json`
3. Esegui con **Execute Workflow**.

### Accortezze importanti su Mac (PATH e ambiente)

n8n avviato dall'app desktop **potrebbe non vedere** `node`, `ffmpeg` o `ANTHROPIC_API_KEY`. Per evitare problemi, **avvia n8n da Terminale** in una sessione dove l'ambiente è a posto:

```bash
# nello stesso Terminale dove 'echo $ANTHROPIC_API_KEY' e 'ffmpeg -version' funzionano:
n8n
# oppure, a seconda di come l'hai installato:
npx n8n
```

Se il nodo Execute Command dà errore **`node: command not found`** o **`ffmpeg: command not found`**:
- avvia n8n da Terminale come sopra (eredita il PATH giusto), **oppure**
- nel `config/projects.json` metti il **percorso completo** di ffmpeg/ffprobe (scoprilo con `which ffmpeg` → es. `/opt/homebrew/bin/ffmpeg`), e nel workflow usa il percorso completo di node (scoprilo con `which node`).

> La fase di **generazione** apre un browser visibile e può richiedere di risolvere captcha: falla quando sei davanti al Mac. Le fasi **titoli** e **montaggio** sono automatiche.

---

## Struttura dell'output

```
/Users/TUONOME/suno/
  browser-profiles/  default/  account-2/     (sessioni Suno)
  canale-lofi/
    cartella-A/  cartella-B/  cartella-C/      (MP3 scaricati e rinominati)
    manifest.json
    export/    playlist_A_1.mp3 ...            (playlist montate)
    tracklist/ playlist_A_1.txt ...            (titolo + timestamp)
```

---

## Problemi comuni (Mac)

| Sintomo | Soluzione |
|---|---|
| `Cannot find module '.../src/suno.js'` | Sei nella cartella sbagliata: `cd ~/suno-audio-automation`. |
| `File di configurazione non trovato` | `cp config/projects.example.json config/projects.json`. |
| `ANTHROPIC_API_KEY` non trovata (da n8n) | Metti la chiave in un file: `echo 'sk-ant-...' > ~/suno-audio-automation/config/anthropic-key.txt`. L'automazione la legge da lì senza bisogno di variabili d'ambiente. |
| `ffmpeg: command not found` (da n8n) | Avvia n8n da Terminale, oppure metti il percorso completo (`which ffmpeg`) in `projects.json`. |
| `node: command not found` (da n8n) | Avvia n8n da Terminale dove `node -v` funziona, oppure usa il percorso completo (`which node`) nel workflow. |
| Il browser non parte | Riesegui `npx playwright install chromium`. |
| Login Google bloccato | Accedi a Suno con email/password o Discord/Apple (vedi README). |
| Compare un captcha | Risolvilo nella finestra: l'automazione aspetta e riparte da sola. |
