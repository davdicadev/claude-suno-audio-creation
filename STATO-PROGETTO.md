# Stato del progetto — Suno Audio Automation (handoff per nuova chat)

> Documento per istruire rapidamente una nuova sessione di Claude Code senza
> rileggere l'intera conversazione. Aggiornato al 2026-07-30.

## 1. Obiettivo

Automazione **locale** che, per uno o più canali YouTube:
1. **Genera** brani su **Suno** via automazione browser (Playwright), **NON via API**.
2. **Scarica** i brani in 3 cartelle: `A` (1° di ogni coppia), `B` (2°), `C` (riserva/singoli).
3. **Riscrive i titoli** con l'API di Claude (SEO), rinominando i file (nomi ASCII-safe).
4. **Monta** ogni playlist in un unico MP3 con **FFMPEG** (ordine alfabetico) + **tracklist** con timestamp.

L'utente lavora principalmente da **n8n** (Mac in produzione; testato molto anche su Windows).

## 2. Repo / branch

- Repo: `davdicadev/claude-suno-audio-creation`
- **Branch di lavoro: `claude/n8n-suno-audio-automation-otag87`** (tutto lo sviluppo va qui).
- Nessuna PR aperta salvo richiesta esplicita.

## 3. Architettura e file chiave

Pipeline in 3 fasi (nodi n8n = comandi `node`):

- **Fase 1 — `src/suno.js`**: generazione + download (Playwright). È il cuore e la parte più complessa.
- **Fase 2 — `src/rewrite-titles.js`**: riscrittura titoli con Claude (`@anthropic-ai/sdk`, modello `claude-haiku-4-5`).
- **Fase 3 — `src/build-playlists.js`**: montaggio FFMPEG + tracklist. Per ogni playlist scrive DUE tracklist: `<nome>.txt` (timestamp + titolo) e `<nome>_con-url.txt` (aggiunge l'URL Suno `https://suno.com/song/<id>` di ogni brano).
- Orchestratore CLI: `src/run.js` (lancia le 3 fasi).

Librerie condivise:
- `src/lib/config.js` — carica/valida `config/projects.json`, calcola il fabbisogno di generazioni, espande `~`.
- `src/lib/suno-selectors.js` — selettori UI Suno + timeout (qui si aggiorna se Suno cambia layout).
- `src/lib/sanitize.js` — nomi file ASCII-safe + titolo "display".
- `src/lib/manifest.js` — legge/scrive `manifest.json`.
- `src/lib/logger.js` — log su console **e su file** (`<baseDir>/suno-log.txt`).

Workflow n8n: `n8n/suno-audio-automation.json` (Manual trigger → Impostazioni → 3 Execute Command).
Guide: `README.md`, `GUIDA-WINDOWS.md`, `GUIDA-MAC.md`.

## 4. `config/projects.json` (NON versionato, è in .gitignore)

Campi principali:
```jsonc
{
  "baseDir": "/percorso/assoluto/output",   // NB: JSON non espande ~ (config.js sì per "~/..")
  "ffmpegPath": "/opt/homebrew/bin/ffmpeg", // METTERE PERCORSO COMPLETO per n8n
  "ffprobePath": "/opt/homebrew/bin/ffprobe",
  "sunoUrl": "https://suno.com",
  "maxGenerazioniPerBatch": 10,             // max ~10 generazioni in parallelo su Suno
  "montaggioVeloce": false,                 // false = ricodifica accurata (default)
  "tagliaSilenzio": true,                   // taglia silenzio >maxSilenzioSecondi a inizio/fine
  "maxSilenzioSecondi": 3,
  "sogliaSilenzioDb": -50,
  "progetti": [
    {
      "nome": "canale-x",
      "attivo": true,
      "sunoProfilo": "default",             // = profilo browser = account Suno
      "keywordsTitoli": ["..."],
      "prompts": [ { "testo": "...", "strumentale": false } ],
      "playlist": { "daA": 1, "daB": 1, "braniPerPlaylist": 50 },
      "margineGenerazione": 0.15
    }
  ]
}
```

Logica playlist: si creano `daA` playlist da A e `daB` da B, ognuna di **esattamente** `braniPerPlaylist` brani. `C` riempie i buchi. Il n. di generazioni si calcola in automatico: `max(daA,daB)*braniPerPlaylist * (1+margine)`.

## 5. Come si lancia

Terminale (vede meglio i log dal vivo):
```bash
cd <cartella-progetto>
node src/suno.js --login-only            # primo login a Suno (una volta per account/profilo)
node src/suno.js                         # solo generazione+download
node src/suno.js --download-only         # SOLO download dei brani già in libreria Suno (0 crediti)
node src/rewrite-titles.js               # solo titoli (usa crediti Claude, pochi)
node src/build-playlists.js              # solo montaggio (0 crediti, lavora su file locali)
node src/run.js                          # tutto
```
Da n8n: nodo Impostazioni con `repoDir` e `configPath` assoluti; i 3 Execute Command chiamano i rispettivi script.

## 6. Ambiente — trappole importanti (già risolte)

- **n8n non mostra l'output finché il comando non finisce** → seguire `<baseDir>/suno-log.txt` in tempo reale (`Get-Content -Wait` su Windows, `tail -f` su Mac).
- **n8n spesso non eredita le variabili d'ambiente** (specie da Homebrew/launchd su Mac):
  - Chiave Claude: mettere in **file** `config/anthropic-key.txt` (gitignorato). Ordine di ricerca: env `ANTHROPIC_API_KEY` → file → campo `anthropicApiKey` nel config.
  - FFMPEG/ffprobe: mettere il **percorso completo** in `projects.json` (`which ffmpeg`). C'è un preflight che dà errore chiaro se mancano.
- **Login Google a Suno**: si usa Chrome (`browserChannel: "chrome"`) + flag anti-automazione. Su Mac serve `baseDir` **assoluto** perché n8n ha HOME diverso.
- **Captcha**: durante la generazione il click "Create" è normale (NON via JS, che aggirerebbe il captcha). Se compare un captcha l'automazione **aspetta** che l'utente lo risolva a mano (fino a 5 min) e riparte.

## 7. Come funziona la Fase 1 adesso (importante)

`src/suno.js` usa un **MODELLO A LOTTI** deterministico (`processProject` + helper `attendiEScaricaLotto`). Scelto dall'utente dopo che la "pipeline" continua tendeva a strozzare la generazione nel tempo.
- Carica `/create` **una volta**, poi **non ricarica** la pagina.
- Ripete: invia `maxGenerazioniPerBatch` (~10) generazioni → **attende** che siano generate e ne **scarica** i ~20 brani → lotto successivo, fino a coprire `fabbisogno.clickTotali`.
- `attendiEScaricaLotto` chiude il lotto quando ha scaricato ~`batch.length*2` brani, oppure dopo qualche giro senza progressi (Suno può rendere meno brani o restituire id "fantasma" che non diventano canzoni); i pronti "spaiati" vanno in C.
- **Download in parallelo** (`DOWNLOAD_CONCURRENCY=6`) con timeout 60s e 3 tentativi (l'endpoint audio di Suno è lento/instabile).
- Discovery dei brani via intercettazione delle risposte del feed di Suno (nessuna API con chiave) + `refreshFeed` in background.
- Accoppiamento A/B dai gruppi di generazione; fallback per titolo+tempo; singoli → C.
- NB: il **download** è la parte più lenta (endpoint Suno). Il modello a lotti è prevedibile ma tra un lotto e l'altro Suno resta un po' fermo mentre si scaricano gli ultimi brani; è il compromesso voluto.

## 8. Cronologia problemi risolti (per contesto)

1. Caratteri speciali nei nomi file → nomi ASCII-safe + titolo display.
2. Login Google bloccato → Chrome + flag anti-automazione; su Mac `baseDir` assoluto.
3. Chiave Claude non vista da n8n → file `config/anthropic-key.txt`.
4. FFMPEG non trovato da n8n → percorso completo + preflight con messaggio chiaro.
5. Playlist troppo corte (spalmava i brani) → si creano solo playlist COMPLETE.
6. Attese morte tra i lotti / pagina ricaricata → pipeline continua senza reload.
7. Download seriale lentissimo + un download lento bloccava tutto → **download in parallelo**.
8. Deadlock: brani generati ma non più rilevati nel feed → reload mirato + abbandono id fantasma.
9. **Montaggio: mix cortissimi** (es. 50 brani in 3 min). Causa: `silencedetect` a -50dB scambiava musica soft (neo-soul/bossa, fade-out) per silenzio → brani tagliati a pochi secondi (di fatto restava 1 brano intero + frammenti quasi muti). Fix: **safety-cap in `computeCuts`** (se il taglio rimuove >30% del brano, tienilo intero) **+ riscrittura di `concatAccurate`** (ritaglia ogni brano in un MP3 temporaneo uniforme, poi unione in `-c copy`). Testato con FFMPEG: durata totale = somma esatta dei segmenti.

## 9. STATO ATTUALE (2026-07-30)

- Fasi 1–2–3 girano **end-to-end senza errori** su Windows dall'interfaccia n8n.
- Ultimo test utente (config `daA:1, daB:1, braniPerPlaylist:50`): download 48+48+6 corretti, titoli e tracklist corretti. Restavano i **mix troppo corti**.
- **Ultimo intervento**: fix montaggio (punto 9 sopra), committato e pushato sul branch.
- **DA VERIFICARE (prossimo passo utente)**: rilanciare **solo il nodo 3** (`node src/build-playlists.js`, 0 crediti) dopo `git pull`; controllare che i due mix durino ~2,5–3 ore ciascuno e che la tracklist sia coerente. Nel log deve comparire `... ; N brani tenuti INTERI (taglio sospetto...)` quando applicabile.

## 10. Note sui costi (sensibile per l'utente)

- **Solo la Fase 1 consuma crediti Suno.** Le Fasi 2 (titoli) e 3 (montaggio) lavorano su file locali → rilanciabili gratis (la 2 usa pochi crediti Claude).
- I brani già generati restano nella **libreria Suno**: `--download-only` li recupera senza rigenerare.
- La config di esempio (`daA:5, daB:5, braniPerPlaylist:50`) = ~500 brani = ~288 generazioni = lavoro di ~ore e molti crediti. Consigliare test piccoli prima.

## 11. Convenzioni git per la nuova chat

- Sviluppare e pushare **solo** su `claude/n8n-suno-audio-automation-otag87` con `git push -u origin <branch>`.
- Commit chiari in italiano. Non aprire PR se non richiesto.
