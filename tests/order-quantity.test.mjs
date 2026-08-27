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
const helperStart = html.indexOf('function lineOrderUnitSize');
const helperEnd = html.indexOf('function orderMatches', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'order quantity helpers must exist');
const helperSource = html.slice(helperStart, helperEnd);
const priceStart = html.indexOf('function offerUnitPrice');
const priceEnd = html.indexOf('function offerPriceLabel', priceStart);
assert.ok(priceStart >= 0 && priceEnd > priceStart, 'offer unit price helper must exist');
const priceSource = html.slice(priceStart, priceEnd);
const pricingPolicyStart = html.indexOf('function itemRetailUnitPrice');
const pricingPolicyEnd = html.indexOf('function offerPriceLabel', pricingPolicyStart);
assert.ok(pricingPolicyStart >= 0 && pricingPolicyEnd > pricingPolicyStart, 'order unit price policy helpers must exist');
const pricingPolicySource = html.slice(pricingPolicyStart, pricingPolicyEnd);

function quantityHelpers() {
  return new Function(
    'draftLines',
    'findOffer',
    `${helperSource}; return { lineOrderUnitSize, lineMinimumOrderUnits, lineOrderUnits, syncDraftLineQuantity, draftOrderUnitsTotal };`,
  )([], () => null);
}

function offerUnitPrice(item, offer, quantity) {
  return new Function(
    'templateOfferUnitPrice',
    `${priceSource}; return offerUnitPrice;`,
  )(() => null)(item, offer, quantity);
}

function registeredSkuUnitCost(item) {
  return new Function(
    'templateOfferUnitPrice',
    `${priceSource}; return registeredSkuUnitCost;`,
  )(() => null)(item);
}

function pricingPolicyHarness(contract, registeredCost = null) {
  return new Function(
    'positiveTemplateInteger',
    'templateUnitCostMode',
    'activeTemplateVersionForPricing',
    'outputContractForOffer',
    'registeredSkuUnitCost',
    `${pricingPolicySource}; return { draftLinePriceResolution, applyDraftLinePrice, lineAppliedUnitPrice, lineAmount, lineInventoryUnitCost };`,
  )(
    (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    (value) => value?.unitCostMode || 'NONE',
    () => ({ bindings: [] }),
    () => ({ contract }),
    () => Number(registeredCost) > 0 ? Number(registeredCost) : null,
  );
}

test('발주 수량 3회와 SKU 주문단위 12개를 총 36개로 동기화한다', () => {
  const { syncDraftLineQuantity, lineOrderUnits } = quantityHelpers();
  const offer = { unitsPerOrder: 12, minOrderUnits: 1 };
  const line = {};
  assert.equal(syncDraftLineQuantity(line, offer, 3), true);
  assert.deepEqual(line, {
    orderUnits: 3,
    unitsPerOrderSnapshot: 12,
    minOrderUnitsSnapshot: 1,
    qty: 36,
  });
  assert.equal(lineOrderUnits(line, offer), 3);
});

test('최소 주문 횟수보다 작은 값과 소수 입력을 거부한다', () => {
  const { syncDraftLineQuantity } = quantityHelpers();
  const offer = { unitsPerOrder: 6, minOrderUnits: 2 };
  assert.equal(syncDraftLineQuantity({}, offer, 1), false);
  assert.equal(syncDraftLineQuantity({}, offer, 2.5), false);
});

test('과거 주문은 저장 당시 주문단위 snapshot으로 주문 횟수를 복원한다', () => {
  const { lineOrderUnitSize, lineOrderUnits } = quantityHelpers();
  const legacy = { qty: 36, offerSnapshot: { unitsPerOrder: 12 } };
  const changedLiveOffer = { unitsPerOrder: 10, minOrderUnits: 1 };
  assert.equal(lineOrderUnitSize(legacy, changedLiveOffer), 12);
  assert.equal(lineOrderUnits(legacy, changedLiveOffer), 3);
  assert.equal(lineOrderUnits({ qty: 35, offerSnapshot: { unitsPerOrder: 12 } }, changedLiveOffer), 0);
});

test('새 발주서에는 발주 수량만 입력되고 주문단위와 총 발주수량은 읽기 전용이다', () => {
  assert.match(html, /<th>발주 수량<\/th><th>SKU 주문단위<\/th><th>총 발주수량<\/th><th>적용 단가<\/th><th>예상 금액<\/th>/);
  assert.match(html, /data-order-qty=/);
  assert.doesNotMatch(html, /data-order-cost=/);
  assert.match(html, /class="mb-unit-cost-readout"/);
  assert.match(html, /소비자가 기준 · 매입가 아님 · EA당/);
  assert.match(html, /단가 확인 필요/);
  assert.match(html, /SKU 기준 · 수정 불가/);
  assert.match(html, /소비자가 × SKU 주문단위 × 발주 수 = 예상 금액/);
  const previewValidation = html.slice(html.indexOf('function previewLineInvalid'), html.indexOf('function templateCellValue'));
  assert.match(previewValidation, /lineAppliedUnitPrice/);
});

test('발주 가능 SKU 조회 표는 요청 컬럼 순서와 빈값 규칙을 지킨다', () => {
  assert.match(
    html,
    /<table class="mb-order-candidate-table" aria-label="발주 가능 SKU"><thead><tr><th>카테고리<\/th><th>상품명<\/th><th>이미지<\/th><th>프렐류드_상품ID<\/th><th>재고<\/th><th>주문단위<\/th><th>적용 단가<\/th><th>추가<\/th><\/tr><\/thead>/,
  );
  const builderStart = html.indexOf('function renderOrderBuilder');
  const builderEnd = html.indexOf('function validateDraft', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart, 'order builder renderer must exist');
  const builderSource = html.slice(builderStart, builderEnd);
  assert.match(builderSource, /imageSource\?'<img/);
  assert.match(builderSource, /imageSource=.*\|\|''/);
  assert.match(builderSource, /Number\(offer\.unitsPerOrder\)>0\?.*:''/);
  assert.match(builderSource, /price==null\?'단가 확인 필요':money\(price\)/);
  assert.match(builderSource, /image\.addEventListener\('error',function\(\)\{image\.remove\(\);\},\{once:true\}\)/);
  assert.match(builderSource, /colspan="8"/);
});

test('저장과 Excel 출력은 발주 횟수와 총 EA를 모두 보존한다', () => {
  assert.match(html, /orderUnits:lineOrderUnits\(line,offer\)/);
  assert.match(html, /unitsPerOrderSnapshot:lineOrderUnitSize\(line,offer\)/);
  assert.match(html, /if\(quantitySemantics==='PACK'\)\{writeQty=Number\(row\.orderUnits\)/);
  assert.match(html, /else writeQty=Number\(row\.qty\)/);
  assert.match(html, /'발주 수량','SKU 주문단위','총 발주수량'/);
});

test('매입가가 있는 일반 발주서는 SKU 등록 매입단가를 사용한다', () => {
  assert.equal(registeredSkuUnitCost({ cost: 6_000 }), 6_000);
  assert.equal(registeredSkuUnitCost({ cost: 0 }), null);
  assert.equal(registeredSkuUnitCost({ cost: -1 }), null);
  assert.equal(registeredSkuUnitCost({}), null);
  const helpers = pricingPolicyHarness({ unitCostMode: 'DIRECT', unitCostColumn: 7 }, 6_000);
  const line = { qty: 36 };
  helpers.applyDraftLinePrice(line, { costAt: '2026-08-27' }, {}, { id: 'SUP-TEST' });
  assert.equal(helpers.lineAppliedUnitPrice(line), 6_000);
  assert.equal(helpers.lineAmount(line), 216_000);
  assert.equal(helpers.lineInventoryUnitCost(line), 6_000);
  assert.equal(line.unitCostSource, 'SKU_MASTER');
  assert.match(html, /적용 단가 .*읽기 전용/);
});

test('매입가 없고 소비자가만 있는 양식은 소비자가 × 주문단위 × 발주 수로 금액을 계산한다', () => {
  const helpers = pricingPolicyHarness({ unitCostMode: 'NONE', retailPriceColumn: 6 });
  const line = { qty: 12 * 3 };
  const resolved = helpers.applyDraftLinePrice(
    line,
    { catalog: { consumerPrice: 1_500 } },
    {},
    { id: 'SUP-MINDOBITTO' },
  );

  assert.equal(resolved.basis, 'RETAIL_PRICE_FALLBACK');
  assert.equal(line.unitPrice, 1_500);
  assert.equal(line.unitCost, 0, '소비자가를 매입원가로 저장하지 않아야 한다');
  assert.equal(helpers.lineAmount(line), 54_000);
  assert.equal(helpers.lineInventoryUnitCost(line), null);
  assert.match(html, /실제 매입가 및 정산·마진 분석용 원가가 아닙니다/);
});

test('매입가와 소비자가가 모두 없으면 발주 단가를 확정하지 않는다', () => {
  const helpers = pricingPolicyHarness({ unitCostMode: 'NONE' });
  const line = { qty: 36 };
  helpers.applyDraftLinePrice(line, {}, {}, { id: 'SUP-TEST' });
  assert.equal(helpers.lineAppliedUnitPrice(line), null);
  assert.equal(helpers.lineAmount(line), null);
});

test('기존 발주서는 저장 단가를 유지하고 입고 시 SKU 등록 단가를 덮어쓰지 않는다', () => {
  assert.match(html, /unitCostSource:line\.unitCostSource\|\|'LEGACY_SNAPSHOT'/);
  const receiveStart = html.indexOf('function receiveOrder');
  const receiveEnd = html.indexOf('function openExecuteOrder', receiveStart);
  const receiveSource = html.slice(receiveStart, receiveEnd);
  assert.doesNotMatch(receiveSource, /item\.cost\s*=/);
  assert.doesNotMatch(receiveSource, /item\.costAt\s*=/);
  assert.match(receiveSource, /cost=lineInventoryUnitCost\(line\)/);
  assert.match(receiveSource, /cost:cost/);
});

test('적용 단가를 확정할 수 없으면 검증과 Excel 다운로드를 차단한다', () => {
  const validationStart = html.indexOf('function validateDraft');
  const validationEnd = html.indexOf('function buildOrderLineSnapshot', validationStart);
  const validationSource = html.slice(validationStart, validationEnd);
  assert.match(validationSource, /lineAppliedUnitPrice\(line\)==null/);
  assert.match(validationSource, /실제 매입단가 또는 발주 양식의 소비자가를 확인/);
  assert.match(html, /draftLines\.every\(function\(line\)\{return lineAppliedUnitPrice\(line\)!=null;\}\)/);
  assert.match(html, /id="mb-download-draft-xlsx"[^>]*\+\(priced\?''\:'disabled'\)/);
  assert.match(html, /startButton\.disabled=!supplier\|\|!draftLines\.length\|\|draftLines\.some\(function\(line\)\{return previewLineInvalid\(line,supplier\);\}\)/);
  assert.doesNotMatch(html, /if\(start\)start\.disabled=false/);
  assert.match(html, /if\(start\)start\.disabled=!order&&\(!draftLines\.length\|\|draftLines\.some\(function\(line\)\{return previewLineInvalid\(line,supplier\);\}\)\)/);
});
