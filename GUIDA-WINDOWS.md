# Guida passo-passo (Windows) — dall'inizio alla prima esecuzione

Questa guida ti porta dal PC "vuoto" alla prima automazione funzionante. Comandi in **PowerShell**. Dove trovi `<...>` sostituisci con i tuoi valori.

> 📁 **Cartella del progetto:** `C:\n8n\suno-audio-automation`
> Tutti i comandi `node ...` / `npm ...` / `git ...` vanno lanciati da qui.
> Primo comando in ogni sessione di PowerShell:
> ```powershell
> cd C:\n8n\suno-audio-automation
> ```

---

## Uso quotidiano (dopo il primo setup)

Una volta completato il setup, **non** devi rifare installazione, chiave Claude o login Suno: restano salvati anche dopo lo spegnimento. Per far partire l'automazione bastano poche righe:

```powershell
cd C:\n8n\suno-audio-automation     # 1. entra nella cartella del progetto (sempre)
git pull                            # 2. (consigliato) scarica gli aggiornamenti
notepad config\projects.json        # 3. (solo se vuoi cambiare prompt/numeri)
node src/run.js                     # 4. avvia tutto (generazione -> titoli -> playlist)
```

Varianti del passo 4:
- `node src/suno.js` — solo generazione + download in A/B/C
- `node src/run.js --phase titles,playlists` — riscrittura titoli + montaggio (se i brani sono già scaricati)

Lascia il browser aperto mentre lavora. Il resto della guida serve solo per il **primo** setup.

---

## Passo 0 — Cosa serve (una volta sola)

Apri PowerShell e verifica cosa hai già:

```powershell
node -v      # deve stampare v22.22 o superiore (richiesto da n8n, vedi sotto)
git --version
ffmpeg -version
ffprobe -version
n8n --version   # se n8n è già installato via npm
```

- **Node.js**: le versioni recenti di n8n richiedono **Node ≥ 22.22** (Node 18 non è più supportato da n8n, anche se questo progetto da solo si accontenta di Node 18+). Consigliato: installa/aggiorna a **Node 24 LTS** ("Krypton", l'LTS attuale ad agosto 2026) da https://nodejs.org — copre sia n8n che l'automazione. Se hai una versione più vecchia già installata, il nuovo installer la sostituisce.
- **Git**: se manca, https://git-scm.com (oppure scarica il progetto come ZIP, vedi Passo 1).
- **FFMPEG + ffprobe**: se mancano, con Scoop:
  ```powershell
  scoop install ffmpeg
  ```
  (Scoop lo usi già: il tuo vecchio workflow puntava a `...\scoop\shims\ffprobe.exe`.)

### Aggiorna n8n (stessa versione dell'altro PC)

Se hai installato n8n globalmente via npm (il caso più comune su Windows), per allineare la versione a quella già in uso sull'altro PC installa la versione **esatta** invece di "latest":

```powershell
npm install -g n8n@2.26.5
n8n --version      # deve mostrare 2.26.5
```

> Nota: per il nodo Execute Command **non era necessario** puntare a questa versione precisa — è disabilitato di default (da riattivare con `NODES_EXCLUDE`, vedi sotto) su **qualunque** versione 2.x, comprese le più recenti (l'ultima ad agosto 2026 è la 2.34.x). Pinnare la 2.26.5 qui è una scelta per avere lo **stesso comportamento identico su entrambi i PC**, non un requisito tecnico per quel nodo. Per aggiornare in futuro a una versione più recente: `npm install -g n8n@latest`.

> Se invece usi l'**app desktop** di n8n, la versione esatta non è selezionabile dall'interfaccia: per pinnarla serve disinstallare l'app e installare n8n via npm come sopra.

> ⚠️ **Nota per il futuro:** n8n **v3.0** (previsto ottobre 2026) eliminerà l'installazione via npm/npx a favore del solo **Docker**. Non riguarda l'aggiornamento di oggi, ma se in futuro `npm install -g n8n` smette di funzionare, dovrai passare a Docker Desktop.

### Il nodo "Execute Command": non è una questione di versione

Dalla versione **2.0** in poi — quindi anche nella 2.26.5 dell'altro PC e anche nell'ultima 2.34.x — n8n **disabilita di default**, per motivi di sicurezza, due nodi: **Execute Command** e **Local File Trigger**. Il nodo è sempre incluso nel pacchetto: semplicemente non compare nella lista finché non lo riattivi con una variabile d'ambiente. Quindi non serve cercare "l'ultima versione che ce l'ha ancora": basta riattivarlo, in qualsiasi versione recente.

Su Windows (PowerShell), variabile d'ambiente **permanente**:

```powershell
setx NODES_EXCLUDE "[]"
```

Questo riabilita tutti i nodi normalmente esclusi (compreso Execute Command). Se preferisci lasciare disabilitato solo Local File Trigger:

```powershell
setx NODES_EXCLUDE "[\"n8n-nodes-base.localFileTrigger\"]"
```

Poi:
1. **Chiudi e riapri PowerShell** (`setx` non aggiorna la sessione già aperta).
2. **Riavvia n8n** (chiudi il processo e rilancialo con `n8n`).
3. Apri un workflow e cerca "Execute Command" nel pannello dei nodi: ora deve comparire.

> Se sull'altro PC il nodo funziona senza che tu ricordi di aver mai impostato questa variabile, probabilmente quell'installazione è più vecchia della 2.0 e non è mai stata aggiornata da allora — un motivo in più per fare l'aggiornamento qui con la variabile già pronta, così il nodo non sparisce al prossimo `npm update`.

### Dipendenze del progetto (Suno automation)

- **Node.js**: come sopra, ≥ 22.22 soddisfa sia n8n sia questo progetto.
- **Git**, **FFMPEG/ffprobe**: come sopra.
- Le librerie del progetto (`@anthropic-ai/sdk`, `playwright`) si installano/aggiornano con `npm install` dentro la cartella del progetto (Passo 2): le versioni in `package.json` sono già quelle testate, non serve toccarle a mano.

---

## Passo 1 — Scarica il progetto

```powershell
cd C:\n8n
git clone -b claude/n8n-suno-audio-automation-otag87 https://github.com/davdicadev/claude-suno-audio-creation.git suno-audio-automation
cd suno-audio-automation
```

> In alternativa, su GitHub: branch `claude/n8n-suno-audio-automation-otag87` → **Code → Download ZIP**, estrai in `C:\n8n\suno-audio-automation`.

---

## Passo 2 — Installa le dipendenze e il browser

> ⚠️ **REGOLA D'ORO — vale per TUTTI i comandi `npm ...` e `node src/...`**
> Vanno eseguiti **dentro la cartella del progetto**. Ogni volta che apri un
> nuovo PowerShell, il **primo** comando da dare è sempre:
> ```powershell
> cd C:\n8n\suno-audio-automation
> ```
> Se compare un errore tipo `Cannot find module 'C:\Users\david\src\suno.js'`,
> vuol dire che sei nella cartella sbagliata: torna qui con il `cd` qui sopra.

```powershell
npm install
npx playwright install chromium
```

Il primo comando scarica le librerie; il secondo scarica il browser Chromium che Playwright userà per pilotare Suno.

---

## Passo 3 — Account Claude, credito e chiave API

1. Vai su **https://console.anthropic.com** e registrati.
2. **Billing → Add credits**: aggiungi il minimo (**5 USD**, bastano per decine di migliaia di titoli).
3. **API Keys → Create Key**: dai un nome (es. `n8n-suno`) e **copia subito** la chiave (`sk-ant-...`), viene mostrata una volta.

Imposta la chiave come variabile d'ambiente (permanente):

```powershell
setx ANTHROPIC_API_KEY "sk-ant-...la-tua-chiave..."
```

**Chiudi e riapri PowerShell** (e riavvia n8n se è aperto), poi verifica:

```powershell
echo $env:ANTHROPIC_API_KEY
```

---

## Passo 4 — Login a Suno (una volta per account)

**Prima crea il file di configurazione** (il login lo legge per sapere dove salvare la sessione). Basta copiare l'esempio, per ora va bene così com'è:

```powershell
copy config\projects.example.json config\projects.json
```

Poi lancia il login (ricorda: sempre dalla cartella `C:\n8n\suno-audio-automation`):

```powershell
node src/suno.js --login-only
```

Si apre una finestra Chrome su Suno: **accedi** (Google/Discord/email). Quando vedi la tua libreria, torna in PowerShell e premi **INVIO**. La sessione resta salvata.

Se vuoi usare **più account** su progetti diversi, fai il login di ciascuno con un nome profilo:

```powershell
node src/suno.js --login-only --profile account-2
```

(poi userai `"sunoProfilo": "account-2"` nel progetto — vedi Passo 5).

> Nota: la generazione consuma i **crediti Suno** del tuo account/piano. L'automazione rispetta i limiti di Suno; se l'account esaurisce i crediti, la generazione si ferma.

---

## Passo 5 — Configura i tuoi progetti

Il file `config\projects.json` l'hai già creato nel Passo 4. Adesso personalizzalo con i tuoi prompt e numeri:

```powershell
notepad config\projects.json
```

Modifica i valori. Esempio minimo per **un** canale:

```jsonc
{
  "baseDir": "C:\\n8n\\suno",
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
      "playlist": { "daA": 2, "daB": 2, "braniPerPlaylist": 50 },
      "margineGenerazione": 0.15
    }
  ]
}
```

- I percorsi Windows vanno con la **doppia barra** `\\` (es. `C:\\n8n\\suno`).
- `daA`/`daB` = quante playlist da A e da B; `braniPerPlaylist` = N brani per playlist.
- Per un secondo canale con un altro account, aggiungi un altro blocco con `"sunoProfilo": "account-2"`.

---

## Passo 6 — Prova con numeri piccoli (consigliato la prima volta)

Prima di lanciare centinaia di brani, fai una prova: nel `projects.json` metti valori piccoli, es. `"daA": 1, "daB": 1, "braniPerPlaylist": 3` (servono ~6 brani, 3 generazioni). Poi:

```powershell
node src/run.js
```

Guarda che: si apra il browser, parta la generazione, i brani vengano scaricati in `C:\n8n\suno\canale-lofi\cartella-A|B|C`, i titoli vengano riscritti e in `...\export\` compaiano gli MP3 montati con le tracklist in `...\tracklist\`.

Se la **generazione** non aggancia un elemento della pagina Suno (campo prompt, toggle strumentale, bottone Create), il messaggio ti dice quale: si corregge in `src\lib\suno-selectors.js` (vedi Passo 9). Le altre fasi sono già collaudate.

Puoi anche lanciare le fasi **una alla volta**:

```powershell
node src/suno.js            # 1. genera + scarica
node src/rewrite-titles.js --dry-run   # 2. anteprima titoli (non rinomina)
node src/rewrite-titles.js             # 2. riscrive e rinomina
node src/build-playlists.js            # 3. monta playlist + tracklist
```

---

## Passo 7 — Esecuzione vera

Rimetti i numeri veri nel `projects.json` (es. `daA:2, daB:2, braniPerPlaylist:50`) e lancia:

```powershell
node src/run.js
```

L'automazione elabora **tutti** i progetti con `"attivo": true`, in sequenza, cambiando account quando serve.

---

## Passo 8 — (Opzionale) Da n8n

> Il workflow usa 3 nodi **Execute Command**: se non l'hai già fatto, riabilitali una volta sola come spiegato nel Passo 0 (`setx NODES_EXCLUDE "[]"`, riapri PowerShell, riavvia n8n) — altrimenti l'import del workflow segnala i nodi come "unrecognized".

1. Apri n8n → **Workflows → Import from File** → scegli `n8n\suno-audio-automation.json`.
2. Apri il nodo **Impostazioni** e imposta:
   - `repoDir` = `C:\n8n\suno-audio-automation`
   - `configPath` = `C:\n8n\suno-audio-automation\config\projects.json`
3. Assicurati che **n8n sia avviato in un ambiente dove è impostata `ANTHROPIC_API_KEY`** (se avvii n8n da PowerShell dopo il `setx`, è già a posto).
4. Premi **Execute Workflow**: lancia in sequenza le 3 fasi.

> Il login a Suno (Passo 4) va fatto comunque una volta da terminale: n8n riusa la sessione salvata.

---

## Passo 9 — Se Suno cambia interfaccia

Se la fase 1 si ferma dicendo che non trova il campo prompt / il toggle / il bottone Create, apri `src\lib\suno-selectors.js`: in cima trovi le liste di selettori. Apri Suno in Chrome, tasto destro sull'elemento → **Ispeziona**, guarda `placeholder` / `aria-label` / `data-testid`, e aggiungi/aggiorna il selettore nella lista giusta. Non serve toccare altro.

---

## Se il login con Google viene bloccato

Google a volte rifiuta il login nelle finestre pilotate da un programma ("Impossibile eseguire l'accesso — questo browser potrebbe non essere sicuro"). L'automazione è già configurata per ridurre il problema: usa il tuo **Google Chrome** installato con i flag anti-blocco. Se compare comunque, in ordine:

1. **Usa un altro metodo di login su Suno.** Nella pagina di login di Suno scegli **email/password** (se il tuo account ne ha una) oppure **Discord** / **Apple**: di solito non applicano lo stesso blocco di Google. È la soluzione più semplice.
   - Se il tuo account Suno è nato con Google e non ha una password, puoi impostarne una: su suno.com → impostazioni account, oppure crea un accesso email.

2. **Assicurati di avere Google Chrome installato** (non solo Edge): l'automazione lo usa in automatico. Se non ce l'hai, scaricalo da google.com/chrome.

3. **Se proprio Google resta bloccato**, si può far riutilizzare all'automazione una sessione fatta a mano nel tuo browser normale (import dei cookie di Suno). È un passaggio in più: se arrivi a questo punto, scrivimi e ti preparo lo script apposito.

Dopo aver fatto il login con uno di questi metodi, l'automazione riusa la sessione salvata: non dovrai rifarlo a ogni esecuzione.

---

## Struttura dell'output

```
C:\n8n\suno\
  browser-profiles\ default\ account-2\      (sessioni Suno)
  canale-lofi\
    cartella-A\  cartella-B\  cartella-C\     (MP3 scaricati e rinominati)
    manifest.json
    export\    playlist_A_1.mp3 ...           (playlist montate)
    tracklist\ playlist_A_1.txt ...           (titolo + timestamp per YouTube)
```

---

## Problemi comuni

| Sintomo | Soluzione |
|---|---|
| `Cannot find module '...\src\suno.js'` | Sei nella cartella sbagliata. Fai `cd C:\n8n\suno-audio-automation` e riprova. |
| `File di configurazione non trovato ...config\projects.json` | Crealo con `copy config\projects.example.json config\projects.json`. |
| `ANTHROPIC_API_KEY` non trovata | Hai fatto `setx` ma non hai riaperto il terminale. Chiudi e riapri PowerShell. |
| `ffmpeg`/`ffprobe` non riconosciuti | Installa con `scoop install ffmpeg`, oppure metti in `projects.json` il percorso completo agli `.exe`. |
| Il browser non parte / errore Playwright | Riesegui `npx playwright install chromium`. |
| Login Google: "questo browser potrebbe non essere sicuro" | Google blocca l'automazione. L'automazione usa già il tuo **Google Chrome** con i flag anti-blocco; se persiste, accedi a Suno con **email/password** o **Discord/Apple** invece che con Google. Vedi la sezione "Login Google bloccato" qui sotto. |
| Il nodo **Execute Command** non compare nel pannello nodi di n8n | Dalla v2.0 n8n lo disabilita di default per sicurezza. Imposta `setx NODES_EXCLUDE "[]"`, **chiudi e riapri PowerShell**, riavvia n8n (vedi Passo 0). |
| n8n si rifiuta di avviarsi dopo l'aggiornamento / errori legati a Node | Controlla `node -v`: le versioni recenti di n8n richiedono **Node ≥ 22.22**. Aggiorna Node da https://nodejs.org (consigliata la LTS 24, "Krypton") e riprova. |
| La generazione non trova un elemento | Aggiorna il selettore in `src\lib\suno-selectors.js` (Passo 9). |
| Montaggio FFMPEG fallisce | Lancia `node src/build-playlists.js --reencode` (ricodifica invece di copiare). |
| Credito Claude esaurito | Ricarica su console.anthropic.com e rilancia solo le fasi mancanti: `node src/run.js --phase titles,playlists`. |
