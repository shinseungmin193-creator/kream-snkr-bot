const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launchPersistentContext('./profile-debug', {
    headless: false,
    channel: 'chrome'
  });

  const page = await browser.newPage();

  page.on('console', msg => console.log('[브라우저]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[페이지에러]', err.message));
  page.on('requestfailed', req => console.log('[요청실패]', req.url(), req.failure()?.errorText));

  await page.goto('https://partner.kream.co.kr', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(10000);

  console.log('현재 URL:', page.url());
  console.log('페이지 제목:', await page.title());

  await page.screenshot({ path: 'kream-debug.png', fullPage: true });
  console.log('스크린샷 저장됨: kream-debug.png');

  console.log('끝내려면 Enter');
  process.stdin.resume();
  process.stdin.once('data', async () => {
    await browser.close();
    process.exit();
  });
})();