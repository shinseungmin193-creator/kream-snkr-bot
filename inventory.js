const { chromium } = require('playwright');
const fs = require('fs');

function reportAutomationProgress(progress) {
  console.log('__AUTOMATION_PROGRESS__:' + JSON.stringify(progress));
}

function parseRow(text) {
  const lines = text.split('\n').map(v => v.trim()).filter(Boolean);

  return {
    stockId: lines[0] || '',
    status: lines[1] || '',
    productCode: lines[2] || '',
    englishName: lines[3] || '',
    koreanName: lines[4] || '',
    option: lines[5] || '',
    purchasePrice: lines[6] || '',
    sellPrice: lines[7] || '',
    totalQty: lines[8] || '',
    soldQty: lines[9] || '',
    remainQty: lines[10] || '',
    createdAt: lines[11] || '',
    updatedAt: lines[12] || '',
    raw: text
  };
}

function getFileSuffix(keyword) {
  const k = String(keyword || '').toLowerCase();

  if (k.includes('포켓몬') || k.includes('pokemon')) return 'pokemon';
  if (k.includes('원피스') || k.includes('onepiece') || k.includes('one piece')) return 'onepiece';

  return 'all';
}

async function readCurrentPage(page) {
  const rowTexts = await page.locator('div.Table_row__ZyONC').evaluateAll(rows =>
    rows.map(r => r.innerText.trim()).filter(Boolean)
  );

  return rowTexts.map(parseRow);
}

function getKeywordFromArgs(args) {
  if (args.includes('--sync-all')) return '';

  const keywordIndex = args.indexOf('--keyword');
  if (keywordIndex >= 0) return String(args[keywordIndex + 1] ?? '');

  // Legacy callers pass the keyword as the first positional argument.
  // There is intentionally no Pokemon default.
  return String(args.find(arg => !arg.startsWith('--')) ?? '');
}

async function selectFilterNearLabel(page, labelText, optionText) {
  const label = page.getByText(labelText, { exact: true }).first();
  if (!(await label.count())) {
    throw new Error(`필터를 찾을 수 없습니다: ${labelText}`);
  }

  const container = label.locator('xpath=ancestor::div[.//button][1]');
  const trigger = container.locator('button').first();
  await trigger.click({ force: true });
  await page.waitForTimeout(300);

  const option = page.getByRole('button', { name: optionText, exact: true }).last();
  await option.click({ force: true });
  await page.waitForTimeout(300);
}

async function clearInputNearLabel(page, labelText) {
  const label = page.getByText(labelText, { exact: true }).first();
  if (!(await label.count())) return;

  const container = label.locator('xpath=ancestor::div[.//input][1]');
  const input = container.locator('input').first();
  if (!(await input.count())) return;

  await input.clear();
  await input.fill('');

  if ((await input.inputValue()) !== '') {
    throw new Error(`${labelText} 입력값을 비우지 못했습니다.`);
  }
}

async function configureLegacySearchConditions(page, keyword) {
  const explicitKeyword = String(keyword ?? '');

  await selectFilterNearLabel(page, '조회기간', '전체');
  await selectFilterNearLabel(page, '판매 상태', '판매중');
  await selectFilterNearLabel(page, '브랜드', '전체');

  await page.getByText('재고 번호', { exact: true }).first().click({ force: true });
  await page.waitForTimeout(300);
  await page.locator('button').filter({ hasText: '상품명' }).last().click({ force: true });
  await page.waitForTimeout(300);

  const searchInput = page.getByPlaceholder('검색어를 입력해주세요.');
  await searchInput.clear();
  await searchInput.fill('');
  await searchInput.fill(explicitKeyword);

  const actualKeyword = await searchInput.inputValue();
  if (actualKeyword !== explicitKeyword) {
    throw new Error(`검색어 적용 실패: expected=${JSON.stringify(explicitKeyword)}, actual=${JSON.stringify(actualKeyword)}`);
  }

  await clearInputNearLabel(page, '옵션 정보');
  console.log(`검색 조건 확인: 검색어=${JSON.stringify(actualKeyword)}, 조회기간=전체, 판매상태=판매중, 브랜드=전체, 옵션정보=빈값`);
}

async function configureSyncSaleStatusOnly(page) {
  const label = page.getByText('판매 상태', { exact: true }).first();
  if (!(await label.count())) throw new Error('판매 상태 필터를 찾을 수 없습니다.');

  const field = label.locator('xpath=ancestor::div[.//button][1]');
  const trigger = field.locator('button').first();
  const currentText = String(await trigger.innerText()).trim();

  if (currentText !== '판매중') {
    await trigger.click({ force: true });
    const overlay = page.locator('div[data-sentry-component="OptionMenu"]:visible').last();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    const option = overlay.getByRole('button', { name: '판매중', exact: true });
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click({ force: true });
    await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  const appliedText = String(await trigger.innerText()).trim();
  if (appliedText !== '판매중') {
    throw new Error(`판매 상태 적용 실패: 현재 표시값=${JSON.stringify(appliedText)}`);
  }

  console.log('판매 상태를 판매중으로 변경 완료');
}

async function waitForInventoryRows(page) {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
}

function getPaginationPageSizeTrigger(page) {
  // The page has several custom dropdowns. Only the bottom page-size trigger has
  // both the table-arrow icon and an exact "N개씩 보기" button label.
  return page.locator('button:has(span[class*="Icon_ic-table-arrow-bottom"])')
    .filter({ hasText: /^\d+개씩 보기$/ })
    .last();
}

async function tryApplyPageSize(page, pageSize) {
  const label = `${pageSize}개씩 보기`;
  console.log(`페이지당 표시 개수 변경 시도: ${pageSize}개`);

  try {
    const trigger = getPaginationPageSizeTrigger(page);
    if (!(await trigger.count())) throw new Error('pagination 페이지 크기 드롭다운을 찾을 수 없음');

    await trigger.scrollIntoViewIfNeeded();
    await trigger.click({ force: true });

    const overlay = page.locator('div[data-sentry-component="OptionMenu"]:visible').last();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    const option = overlay.getByRole('button', { name: label, exact: true });
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click({ force: true });
    await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await waitForInventoryRows(page);

    await page.waitForFunction(expected => {
      const buttons = [...document.querySelectorAll('button')];
      return buttons.some(button => {
        const hasTableArrow = Boolean(button.querySelector('span[class*="Icon_ic-table-arrow-bottom"]'));
        return hasTableArrow && (button.innerText || '').trim() === expected;
      });
    }, label, { timeout: 15000 });

    const selectedText = String(await getPaginationPageSizeTrigger(page).innerText()).trim();
    if (selectedText !== label) {
      throw new Error(`현재 표시값 불일치: expected=${label}, actual=${JSON.stringify(selectedText)}`);
    }

    const totalCount = await getTotalInventoryCount(page);
    const expectedRows = totalCount > 0 ? Math.min(totalCount, pageSize) : 0;
    if (expectedRows > 0) {
      await page.waitForFunction(expected => document.querySelectorAll('div.Table_row__ZyONC').length === expected,
        expectedRows, { timeout: 15000 });
    }

    const rowCount = await page.locator('div.Table_row__ZyONC').count();
    console.log(`페이지당 표시 개수 적용 완료: ${pageSize}개`);
    console.log(`첫 페이지 행 수: ${rowCount}개`);
    return true;
  } catch (error) {
    const displayed = await getPaginationPageSizeTrigger(page).innerText().catch(() => '확인 불가');
    console.log(`${label} 적용 실패: ${error.message} (현재 표시값=${JSON.stringify(String(displayed).trim())})`);
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

async function optimizeSyncPageSize(page) {
  if (await tryApplyPageSize(page, 100)) return 100;
  console.log('100개 적용 실패, 100개씩 보기 두 번째 시도');
  if (await tryApplyPageSize(page, 100)) return 100;
  console.log('100개 두 차례 적용 실패, 50개씩 보기로 재시도');
  if (await tryApplyPageSize(page, 50)) return 50;

  const currentText = await getPaginationPageSizeTrigger(page).innerText().catch(() => '10개씩 보기');
  const currentSize = Number(String(currentText).match(/\d+/)?.[0] || 10);
  console.log(`100개/50개 변경 실패: 기존 ${currentSize}개씩 보기로 계속 수집`);
  return currentSize;
}

async function getTotalInventoryCount(page) {
  const title = page.getByText('재고 목록', { exact: true }).first();
  if (!(await title.count())) return 0;
  const countText = await title.locator('xpath=following-sibling::*[1]').textContent().catch(() => '');
  const count = Number(String(countText || '').replace(/[^\d]/g, ''));
  return Number.isFinite(count) ? count : 0;
}

async function moveToPage(page, pageNo) {
  const current = Number(new URL(page.url()).searchParams.get('page') || 1);
  if (current === pageNo) return;

  const numberedButton = page.getByRole('button', { name: String(pageNo), exact: true }).last();
  if (await numberedButton.isVisible().catch(() => false)) {
    await numberedButton.click({ force: true });
  } else {
    const nextUrl = new URL(page.url());
    nextUrl.searchParams.set('page', String(pageNo));
    await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await waitForInventoryRows(page);
}

(async () => {
  const args = process.argv.slice(2);
  const keyword = getKeywordFromArgs(args);
  const verifyFiltersOnly = args.includes('--verify-filters');
  const suffix = getFileSuffix(keyword);

  const inventoryFile =
    suffix === 'all'
      ? 'inventory_all.json'
      : `inventory_${suffix}.json`;

  reportAutomationProgress({ current: 0, total: null, percent: 1, step: 'Chrome 연결', message: 'KREAM 로그인 Chrome 연결 중' });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  reportAutomationProgress({ current: 0, total: null, percent: 3, step: 'KREAM 페이지 이동', message: '재고별 입찰관리 페이지 이동 중' });
  await page.goto('https://partner.kream.co.kr/business/ask-sales', {
    waitUntil: 'networkidle'
  });

  console.log('재고별 입찰관리 접속');
  console.log(`검색어: ${keyword}`);
  console.log(`저장 파일: ${inventoryFile}`);

  await page.waitForTimeout(2000);

  let syncSearchValueBefore = null;
  reportAutomationProgress({ current: 0, total: null, percent: 5, step: '검색 조건 설정', message: args.includes('--sync-all') ? '판매 상태를 판매중으로 변경 중' : `${keyword} 검색 조건 적용 중` });
  if (args.includes('--sync-all')) {
    syncSearchValueBefore = await page.getByPlaceholder('검색어를 입력해주세요.').inputValue();
  }

  reportAutomationProgress({ current: 0, total: null, percent: 7, step: '검색 실행', message: '검색 버튼 클릭 및 결과 로딩 중' });

  if (args.includes('--sync-all')) {
    // Inventory sync changes only the sale-status field. Every other search
    // field stays exactly as the page loaded it.
    await configureSyncSaleStatusOnly(page);
  } else {
    await configureLegacySearchConditions(page, keyword);
  }

  await page
    .locator('button')
    .filter({ hasText: '검색' })
    .click({ force: true });

  console.log('검색 완료');
  reportAutomationProgress({ current: 0, total: null, percent: 9, step: '검색 결과 확인', message: '검색 결과 로딩 완료' });

  await page.waitForTimeout(3000);

  if (args.includes('--sync-all')) {
    const syncSearchValueAfter = await page.getByPlaceholder('검색어를 입력해주세요.').inputValue();
    if (syncSearchValueAfter !== syncSearchValueBefore) {
      throw new Error(`동기화 중 검색어 입력값이 변경됨: before=${JSON.stringify(syncSearchValueBefore)}, after=${JSON.stringify(syncSearchValueAfter)}`);
    }
    console.log(`검색어 입력칸 미변경 확인: ${JSON.stringify(syncSearchValueAfter)}`);
  }

  let effectivePageSize = 10;
  let totalPages = 0;
  let expectedTotalCount = 0;

  if (args.includes('--sync-all')) {
    reportAutomationProgress({ current: 0, total: null, percent: 10, step: '페이지 크기 변경', message: '페이지당 100개씩 보기 적용 중' });
    effectivePageSize = await optimizeSyncPageSize(page);
    expectedTotalCount = await getTotalInventoryCount(page);
    totalPages = expectedTotalCount > 0 ? Math.ceil(expectedTotalCount / effectivePageSize) : 0;
    if (totalPages > 0) console.log(`총 ${totalPages}페이지 수집 시작 (판매중 재고 ${expectedTotalCount}개)`);
    else console.log(`전체 페이지 수 확인 실패: ${effectivePageSize}개씩 보기 기준으로 끝까지 수집`);
    reportAutomationProgress({
      current: 0,
      total: expectedTotalCount || null,
      percent: 12,
      step: '판매 재고 수집',
      message: totalPages ? `총 ${totalPages}페이지 · 판매중 재고 ${expectedTotalCount}개 확인` : '전체 대상 계산 중'
    });
  }

  if (verifyFiltersOnly) {
    const actualKeyword = await page.getByPlaceholder('검색어를 입력해주세요.').inputValue();
    console.log(`__SYNC_FILTER_VERIFIED__: 검색창 값=${JSON.stringify(actualKeyword)}, 미변경 확인 완료`);
    await page.close();
    process.exit(0);
  }

  let allItems = [];

  // Safety cap prevents an accidental infinite loop while allowing 552+ records.
  for (let pageNo = 1; pageNo <= (totalPages || 1000); pageNo++) {
    reportAutomationProgress({
      current: allItems.length,
      total: expectedTotalCount || null,
      percent: expectedTotalCount > 0 ? 12 + (allItems.length / expectedTotalCount) * 88 : Math.min(85, 10 + (pageNo - 1) * 5),
      step: '판매 재고 수집',
      message: totalPages ? `${pageNo}/${totalPages} 페이지 수집 중` : `${pageNo}페이지 수집 중`
    });
    await moveToPage(page, pageNo);
    console.log(`===== ${totalPages ? `${pageNo}/${totalPages}` : pageNo} 페이지 =====`);

    const items = await readCurrentPage(page);

    console.log(`상품 수: ${items.length}`);

    allItems.push(...items);

    console.log(`누적: ${allItems.length}`);

    console.log(`${totalPages ? `${pageNo}/${totalPages}` : pageNo} 페이지 수집 완료`);
    reportAutomationProgress({
      current: allItems.length,
      total: expectedTotalCount || null,
      percent: expectedTotalCount > 0 ? Math.min(100, 12 + (allItems.length / expectedTotalCount) * 88) : Math.min(90, 10 + pageNo * 5),
      step: '판매 재고 수집',
      message: `${totalPages ? `${pageNo}/${totalPages} 페이지` : `${pageNo}페이지`} 수집 완료 · 누적 ${allItems.length}개`
    });
    if (totalPages && pageNo >= totalPages) break;
    if (!totalPages && items.length < effectivePageSize) break;
  }

  fs.writeFileSync(
    inventoryFile,
    JSON.stringify(allItems, null, 2),
    'utf8'
  );

  // 기존 기능 보호용: 기존 파일도 같이 저장
  fs.writeFileSync(
    'inventory_all.json',
    JSON.stringify(allItems, null, 2),
    'utf8'
  );

  console.log(`총 ${allItems.length}개 저장 완료`);
  reportAutomationProgress({ current: allItems.length, total: allItems.length, percent: 100, step: '파일 저장', message: `총 ${allItems.length}개 저장 완료` });
  console.log(`${inventoryFile} 생성 완료`);
  console.log('inventory_all.json 호환 저장 완료');

  await page.close();

  console.log('inventory.js 완료');
  process.exit(0);
})();
