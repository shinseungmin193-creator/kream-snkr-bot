const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  const rows = await page.locator('#content div').evaluateAll(els =>
    els
      .map((el, i) => ({
        index: i,
        text: el.innerText?.trim()
      }))
      .filter(x => x.text && x.text.includes('포켓몬'))
      .slice(0, 30)
  );

  console.log(JSON.stringify(rows, null, 2));
})();