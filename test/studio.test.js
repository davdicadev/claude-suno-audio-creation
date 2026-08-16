"use strict";

/**
 * Prova del percorso "apri in Studio" SENZA toccare Suno e senza spendere
 * crediti: gira contro una pagina finta (test/fixture-suno.js) che riproduce i
 * comportamenti che contano davvero:
 *   - il bottone (…) compare solo passandoci sopra col mouse;
 *   - in pagina ci sono altri (…) che NON sono del brano (barra laterale);
 *   - il sottomenu 'Edit' si apre solo al PASSAGGIO del puntatore, non al click;
 *   - a volte compare in ritardo la finestra "come vuoi aprirlo?".
 *
 * Uso:  npm run test:studio
 * (Su un browser diverso: SUNO_TEST_BROWSER=/percorso/chrome npm run test:studio)
 */

const { chromium } = require("playwright");
const { server } = require("./fixture-suno");
const studio = require("../src/lib/suno-studio");
const SEL = require("../src/lib/suno-selectors");

SEL.studio.timeouts.caricamento = 20000; // il finto Studio e' istantaneo

let falliti = 0;
function ok(nome, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${nome}${extra ? " -> " + extra : ""}`);
  if (!cond) falliti++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const opzioni = { headless: true };
  if (process.env.SUNO_TEST_BROWSER) {
    opzioni.executablePath = process.env.SUNO_TEST_BROWSER;
  }
  const browser = await chromium.launch(opzioni);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  try {
    const page = await ctx.newPage();
    await page.goto(base + "/create");

    // 1) lettura della lista brani dal DOM della pagina /create
    const brani = await studio.elencaBrani(page);
    ok("elencaBrani trova i brani della pagina", brani.length === 3, `${brani.length} trovati`);
    ok(
      "id e titolo letti correttamente",
      brani[0].id === "5be767f7-ca3b-44ee-b98c-8073c2157b2d" && /Rainy Caf/.test(brani[0].titolo),
      JSON.stringify(brani[0])
    );

    // 2) il menu (…) e' quello della riga giusta, non il primo della pagina
    const trovata = await studio.trovaRigaBrano(page, { songId: brani[1].id });
    ok("trovaRigaBrano risale alla riga del brano", !!trovata);
    if (trovata) {
      const id = await trovata.bottone.getAttribute("data-id");
      ok("il (…) individuato appartiene a QUEL brano", id === brani[1].id, id);
      ok("il (…) e' nascosto finche' non passi sopra la riga", !(await trovata.bottone.isVisible()));
    }

    // 3) giro completo con il mouse virtuale
    const t0 = Date.now();
    const res = await studio.apriInStudioDaCreate(page, {
      songId: brani[0].id,
      titolo: brani[0].titolo,
      prefisso: "      [test] ",
    });
    const durata = Date.now() - t0;
    ok("apriInStudioDaCreate arriva su Studio", /\/studio\//.test(res.url), res.url);
    ok("senza attese morte (< 15s)", durata < 15000, `${durata}ms`);

    // 4) variante con la finestra di scelta che compare in ritardo
    const pageD = await ctx.newPage();
    await pageD.goto(base + "/create?dialogo=1");
    const braniD = await studio.elencaBrani(pageD);
    const resD = await studio.apriInStudioDaCreate(pageD, {
      songId: braniD[0].id,
      prefisso: "      [test-dialogo] ",
    });
    ok("gestisce la finestra di scelta", /\/studio\//.test(resD.url), resD.url);

    // 5) controprova: il click "che teletrasporta" NON attraversa i menu.
    //    E' il motivo per cui serviva muovere il mouse a mano.
    const pageN = await ctx.newPage();
    await pageN.goto(base + "/create");
    let esito = "click riuscito";
    try {
      await pageN.locator('.row button[aria-label="More menu contents"]').first().click({ timeout: 3000 });
      await pageN.getByRole("menuitem", { name: "Open in Studio" }).click({ timeout: 3000 });
    } catch (e) {
      esito = String(e.message).split("\n")[0].slice(0, 60);
    }
    ok(
      "il click diretto NON apre Studio (serve il passaggio del mouse)",
      !/\/studio\//.test(pageN.url()),
      esito
    );
  } catch (e) {
    console.log("ERRORE:", e && e.stack ? e.stack : e);
    falliti++;
  } finally {
    await browser.close();
    server.close();
  }

  console.log(falliti === 0 ? "\nTUTTI I TEST PASSATI" : `\n${falliti} TEST FALLITI`);
  process.exit(falliti === 0 ? 0 : 1);
})();
