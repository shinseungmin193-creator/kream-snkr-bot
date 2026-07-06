const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launchPersistentContext('./profile', {
    headless: false,
    channel: 'chrome',
    viewport: null,
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();

  page.on('console', msg => console.log('[브라우저]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[페이지에러]', err.message));
  page.on('requestfailed', req => console.log('[요청실패]', req.url(), req.failure()?.errorText));

  await page.goto('https://partner.kream.co.kr', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('열림. 화면 확인해. 끝내려면 터미널에서 Enter.');

  process.stdin.resume();
  process.stdin.once('data', async () => {
    await browser.close();
    process.exit();
  });
})();