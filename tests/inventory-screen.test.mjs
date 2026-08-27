import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function decodeSrcdoc(raw) {
  const start = raw.indexOf('srcdoc="') + 8;
  const end = raw.lastIndexOf('"></iframe>');
  return raw.slice(start, end)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const raw = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const html = decodeSrcdoc(raw);

test('발주 추천 탭은 임시로 숨기되 기존 화면과 기능은 보존한다', () => {
  assert.match(html, /#munbang-inventory \.mb-nav\[hidden\] \{ display: none !important; \}/);
  assert.match(html, /#munbang-inventory \.mb-sidebar \{ display: grid; grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(
    html,
    /<button class="mb-nav" data-page="reorders" aria-label="발주 추천" type="button" hidden data-temporarily-hidden="true">/,
  );
  assert.match(html, /<section class="mb-page" data-page-panel="reorders">/);
  assert.match(html, /function renderReorders\(\)/);
});

test('재고 현황은 요청한 8개 컬럼을 요청 순서대로 표시한다', () => {
  assert.match(
    html,
    /<table class="mb-inventory-table"[^>]*>\s*<thead><tr><th>상태<\/th><th>브랜드명<\/th><th>카테고리<\/th><th>상품명<\/th><th>프렐류드_상품ID<\/th><th>재고<\/th><th>발주량<\/th><th>발주처<\/th><\/tr><\/thead>/,
  );
  assert.match(html, /<td colspan="8"><div class="mb-empty">조건에 맞는 SKU가 없습니다\./);
  assert.doesNotMatch(html, /<th>상품 \/ Option·SKU<\/th>/);
});

test('판매 상태 필터는 판매중과 판매 중지 품목을 모두 지원한다', () => {
  assert.match(html, /<option value="active">판매중<\/option><option value="inactive">판매 중지<\/option>/);

  const start = html.indexOf('function inventoryFiltered');
  const end = html.indexOf('function renderInventory', start);
  assert.ok(start >= 0 && end > start, 'inventory filter helper must exist');
  const source = html.slice(start, end);
  const controls = { supplier: '', stat: '', query: '' };
  const root = {
    querySelector(selector) {
      if (selector === '#mb-supplier-filter') return { value: controls.supplier };
      if (selector === '#mb-status-filter') return { value: controls.stat };
      if (selector === '#mb-inventory-search') return { value: controls.query };
      throw new Error(`unexpected selector: ${selector}`);
    },
  };
  const items = [
    { id: 'SKU-A', productId: 'PRE-A', name: '활성 상품', brand: '브랜드A', category: '문구', option: '', supplier: '미도리', active: true },
    { id: 'SKU-B', productId: 'PRE-B', name: '중지 상품', brand: '브랜드B', category: '잡화', option: '', supplier: 'OIMU', active: false },
  ];
  const inventoryFiltered = new Function(
    'root',
    'items',
    'suppliersForItem',
    `${source}; return inventoryFiltered;`,
  )(root, items, (item) => [{ name: item.supplier }]);

  assert.deepEqual(inventoryFiltered().map((item) => item.id), ['SKU-A', 'SKU-B']);
  controls.stat = 'active';
  assert.deepEqual(inventoryFiltered().map((item) => item.id), ['SKU-A']);
  controls.stat = 'inactive';
  assert.deepEqual(inventoryFiltered().map((item) => item.id), ['SKU-B']);
  controls.stat = '';
  controls.query = '잡화';
  assert.deepEqual(inventoryFiltered().map((item) => item.id), ['SKU-B']);
});

test('재고 행은 판매 상태와 확정 후 미입고 발주량을 렌더링한다', () => {
  const start = html.indexOf('function renderInventory');
  const end = html.indexOf('function groupedProducts', start);
  assert.ok(start >= 0 && end > start, 'inventory renderer must exist');
  const source = html.slice(start, end);
  assert.match(source, /active\?'판매중':'판매 중지'/);
  assert.match(source, /Number\(item\.incoming\)\|\|0/);
  assert.match(source, /item\.brand/);
  assert.match(source, /item\.category/);
  assert.match(source, /item\.productId/);
});

test('발주 하기는 선택 발주처를 이어받아 발주 추가 화면을 연다', () => {
  assert.match(html, /id="mb-inventory-order"[^>]*>＋ 발주 하기<\/button>/);
  assert.match(html, /#mb-inventory-order'\)\.addEventListener\('click'/);
  assert.match(html, /supplierForName\(supplierName\)/);
  assert.match(html, /openOrderEditor\(null,false,\{parentPage:'inventory',childLabel:'발주 추가'/);
});
