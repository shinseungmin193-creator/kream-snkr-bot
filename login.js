const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launchPersistentContext('./profile', {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();

  await page.goto('https://partner.kream.co.kr', {
    waitUntil: 'load',
    timeout: 60000
  });

  console.log('크림 열림. 로그인/OTP 완료 후 터미널에서 Enter.');

  process.stdin.resume();
  process.stdin.once('data', async () => {
    await browser.close();
    console.log('세션 저장 완료.');
    process.exit();
  });
})();