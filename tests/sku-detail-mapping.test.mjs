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
const helperStart = html.indexOf('function detailFieldMeta');
const helperEnd = html.indexOf('function spreadsheetDiffItems', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'SKU detail helpers must exist');
const helperSource = html.slice(helperStart, helperEnd);

function makeHelpers({ offers = [] } = {}) {
  return new Function(
    'supplierOffers',
    'registeredSkuUnitCost',
    'catalogScalarText',
    'money',
    'number',
    'templateColumnLetter',
    'findSupplier',
    'brandCatalogFor',
    'htmlSafe',
    `${helperSource}; return { detailFieldMeta, detailFieldValue, detailDisplayValue, detailMappingRows, detailLinkedGroups, switchDetailTab };`,
  )(
    offers,
    (item) => Number(item?.cost) > 0 ? Number(item.cost) : null,
    (value) => value == null ? '' : String(value),
    (value) => `${Number(value).toLocaleString('ko-KR')}원`,
    (value, digits = 1) => Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: digits }),
    (column) => String.fromCharCode(64 + Number(column)),
    (id) => ({ id, name: id === 'SUP-A' ? '미도리' : '동기바른애' }),
    (supplierId, scopeId) => ({ id: scopeId, name: scopeId === 'BRAND-A' ? "Traveler's notebook company" : 'MILAN', sheet: `Template_${scopeId}`, linkStatus: 'CONFIRMED' }),
    (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  );
}

test('엑셀 등록 SKU는 원본 컬럼 순서와 standard/custom/ignore 값을 유지한다', () => {
  const helpers = makeHelpers();
  const item = {
    id: 'SKU-1', productId: 'PRE-1', name: '케빈노트', supplierCode: '500912-2B03ED',
    option: '기본 옵션', price: 1000000, pack: 6, min: 6, cost: 600000,
    customAttributes: { '비고': '한정판' },
    importColumnMapping: [
      { column: 'A', sourceHeader: '상품번호', targetField: 'code' },
      { column: 'B', sourceHeader: '제품명', targetField: 'name' },
      { column: 'C', sourceHeader: '비고', targetField: 'custom:비고' },
      { column: 'D', sourceHeader: '내부용', targetField: 'ignore' },
    ],
  };
  const offer = { supplierCode: item.supplierCode, unitsPerOrder: 6, minimumOrderQty: 6 };
  const rows = helpers.detailMappingRows(item, offer);
  assert.deepEqual(rows.map((row) => row.sourceHeader), ['상품번호', '제품명', '비고', '내부용']);
  assert.equal(helpers.detailFieldValue(item, offer, 'code', '상품번호'), '500912-2B03ED');
  assert.equal(helpers.detailFieldValue(item, offer, 'custom:비고', '비고'), '한정판');
  assert.equal(helpers.detailFieldMeta('', '미지 컬럼').label, '미매칭');
  assert.equal(helpers.detailFieldMeta('ignore', '내부용').label, '상품 등록에서 제외');
  assert.equal(helpers.detailFieldMeta('price', 'RETAIL PRICE').label, '소비자가');
});

test('구글 시트 SKU는 sheetProfile 원본 순서와 출력 전용 값을 표시한다', () => {
  const helpers = makeHelpers();
  const item = {
    id: 'SKU-2', name: '상품', price: 12000, pack: 12,
    catalog: { customFields: { code: 'ABC-1' } },
    sheetProfile: { fields: [
      { id: 'code', label: '상품번호', column: 1, columnLetter: 'A', semantic: 'supplierCode' },
      { id: 'qty', label: '발주수', column: 6, columnLetter: 'F', semantic: 'qty', readOnly: true },
      { id: 'amount', label: '금 액', column: 7, columnLetter: 'G', semantic: 'amount', readOnly: true },
    ] },
  };
  const offer = { supplierCode: 'ABC-1', unitsPerOrder: 12 };
  const rows = helpers.detailMappingRows(item, offer);
  assert.deepEqual(rows.map((row) => row.column), ['A', 'F', 'G']);
  assert.equal(helpers.detailFieldValue(item, offer, 'supplierCode', '상품번호', 'code'), 'ABC-1');
  assert.equal(helpers.detailFieldValue(item, offer, 'qty', '발주수', 'qty'), '발주 시 입력');
  assert.equal(helpers.detailFieldValue(item, offer, 'amount', '금 액', 'amount'), '발주 시 자동 계산');
});

test('SKU 상세는 발주처·브랜드별 그룹을 분리하고 동적 값을 escape한다', () => {
  const offers = [
    { supplierId: 'SUP-A', scopeId: 'BRAND-A', sku: 'SKU-X', supplierCode: '<A>', importColumnMapping: [{ column: 'A', sourceHeader: '상품번호', targetField: 'code' }] },
    { supplierId: 'SUP-B', scopeId: 'BRAND-B', sku: 'SKU-X', supplierCode: 'B-2', importColumnMapping: [{ column: 'A', sourceHeader: '상품번호', targetField: 'code' }] },
  ];
  const helpers = makeHelpers({ offers });
  const rendered = helpers.detailLinkedGroups({ id: 'SKU-X', brand: '기본 브랜드', importSource: { sheet: '상품목록' } });
  assert.equal((rendered.match(/class="mb-linked-group"/g) || []).length, 2);
  assert.match(rendered, /미도리 · Traveler&#39;s notebook company/);
  assert.match(rendered, /&lt;A&gt;/);
  assert.doesNotMatch(rendered, /<A>/);
});

test('SKU 상세 3개 탭은 ARIA와 클릭·키보드 전환을 지원한다', () => {
  assert.match(html, /role="tablist" aria-label="SKU 상세 정보"/);
  assert.match(html, /data-detail-tab="basic"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(html, /data-detail-panel="ledger"[^>]*role="tabpanel"/);
  assert.match(html, /data-detail-panel="cost"[^>]*role="tabpanel"/);
  assert.match(html, /detailTab=event\.target\.closest\('\[data-detail-tab\]'/);
  assert.match(html, /\['ArrowLeft','ArrowRight','Home','End'\]/);
  assert.match(html, /aria-label="SKU 상세 닫기"/);
});

test('모바일에서 연동 컬럼은 페이지 가로 스크롤 없이 순차 배치된다', () => {
  assert.match(html, /\.mb-linked-table \{ min-width: 0; table-layout: auto; \}/);
  assert.match(html, /\.mb-linked-table td \{ display: grid; grid-template-columns: 112px minmax\(0,1fr\)/);
  assert.match(html, /\.mb-detail-actions > button \{ flex: 1 1 calc\(50% - 4px\); min-height: 44px; \}/);
});
