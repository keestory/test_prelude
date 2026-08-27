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
const helperStart = html.indexOf('function validateSkuEditDraft');
const helperEnd = html.indexOf('function skuEditField', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'SKU edit pure helpers must exist');
const helperSource = html.slice(helperStart, helperEnd);
const { validateSkuEditDraft, applySkuEditDraft } = new Function(
  `${helperSource}; return { validateSkuEditDraft, applySkuEditDraft };`,
)();

test('SKU 수정은 내부 운영값만 바꾸고 원본 연동값과 식별자를 보존한다', () => {
  const item = {
    id: 'MIDORI-001', productId: 'PRE-001', supplierId: 'SUP-MIDORI', supplierCode: '500912',
    name: '이전 상품', option: '기본 옵션', category: '문구', price: 10500,
    lead: 7, safety: 3, target: 14, stock: 12, pack: 6, min: 12, cost: 9000,
    catalog: { localizedName: '이전 상품', consumerPrice: 10500, customFields: { retail: 10500, name: '원본 상품명' } },
    importSource: { sheet: '노트', row: 4 },
  };
  const offer = { id: 'OFR-MIDORI-001', sku: item.id, supplierId: item.supplierId, unitsPerOrder: 6, minOrderUnits: 2, minimumOrderQty: 12, priceType: 'FIXED', fixedPrice: 9000 };
  const originalCustomFields = structuredClone(item.catalog.customFields);
  const changes = applySkuEditDraft(item, {
    name: '새 상품명', option: '블루', category: '노트', consumerPrice: '12000',
    unitCost: '9000', unitsPerOrder: '6', minimumOrderQty: '12', lead: '5', safety: '2', target: '10',
  }, '2026-08-27T10:00:00.000Z', offer);

  assert.equal(changes.length, 7);
  assert.equal(item.name, '새 상품명');
  assert.equal(item.catalog.localizedName, '새 상품명');
  assert.equal(item.price, 12000);
  assert.equal(item.catalog.consumerPrice, 12000);
  assert.equal(item.id, 'MIDORI-001');
  assert.equal(item.productId, 'PRE-001');
  assert.equal(item.supplierId, 'SUP-MIDORI');
  assert.equal(item.supplierCode, '500912');
  assert.equal(item.stock, 12);
  assert.equal(item.pack, 6);
  assert.equal(item.min, 12);
  assert.equal(offer.unitsPerOrder, 6);
  assert.equal(offer.minOrderUnits, 2);
  assert.deepEqual(item.catalog.customFields, originalCustomFields);
  assert.deepEqual(item.importSource, { sheet: '노트', row: 4 });
  assert.equal(item.manualOverrides.source, 'SKU_DETAIL');
  assert.equal(item.editHistory.length, 1);
});

test('SKU 수정값은 필수값·가격·재고 기준일 범위를 검증한다', () => {
  const errors = validateSkuEditDraft({
    name: ' ', option: '', category: '', consumerPrice: '0',
    unitCost: '0', unitsPerOrder: '6', minimumOrderQty: '10', lead: '', safety: '20', target: '10',
  });
  assert.ok(errors.name);
  assert.ok(errors.option);
  assert.ok(errors.category);
  assert.ok(errors.consumerPrice);
  assert.ok(errors.unitCost);
  assert.ok(errors.minimumOrderQty);
  assert.ok(errors.lead);
  assert.ok(errors.target);
  assert.deepEqual(validateSkuEditDraft({
    name: '상품', option: '기본', category: '문구', consumerPrice: '10500',
    unitCost: '1300', unitsPerOrder: '24', minimumOrderQty: '48', lead: '7', safety: '3', target: '14',
  }), {});
});

test('동기바른애 24개입과 EA당 출고가는 독립적으로 수정되고 이력을 남긴다', () => {
  const item = {
    id: 'MILAN-M-01', supplierId: 'SUP-DONGGI', name: '밀란 샤프심', option: '기본 옵션', category: '문구',
    price: 2000, cost: 1300, pack: 24, min: 24, lead: 7, safety: 3, target: 14,
    catalog: { localizedName: '밀란 샤프심', consumerPrice: 2000, customFields: { '입수량': 24 } }, stock: 0,
  };
  const offer = {
    id: 'OFR-DONGGI-M-01', sku: item.id, supplierId: 'SUP-DONGGI', unitLabel: '입수',
    unitsPerOrder: 24, minOrderUnits: 1, minimumOrderQty: 24,
    priceType: 'FIXED', fixedPrice: 1300, outboundPrice: 1300,
  };
  const sourceFields = structuredClone(item.catalog.customFields);
  const changes = applySkuEditDraft(item, {
    name: item.name, option: item.option, category: item.category, consumerPrice: '2000',
    unitCost: '1400', unitsPerOrder: '24', minimumOrderQty: '48', lead: '7', safety: '3', target: '14',
  }, '2026-08-27T11:00:00.000Z', offer);

  assert.deepEqual(changes.map((change) => change.field), ['unitCost', 'minimumOrderQty']);
  assert.equal(item.pack, 24);
  assert.equal(item.min, 48);
  assert.equal(item.cost, 1400);
  assert.equal(offer.unitsPerOrder, 24);
  assert.equal(offer.minOrderUnits, 2);
  assert.equal(offer.minimumOrderQty, 48);
  assert.equal(offer.fixedPrice, 1400);
  assert.equal(offer.outboundPrice, 1400);
  assert.deepEqual(item.catalog.customFields, sourceFields);
  assert.equal(offer.conditionHistory.length, 1);
});

test('상세 drawer는 수정·취소·저장 UI와 잠금 안내를 제공한다', () => {
  assert.match(html, /id="mb-detail-edit"[^>]*data-edit-sku/);
  assert.match(html, /id="mb-save-sku-edit"/);
  assert.match(html, /data-sku-edit-cancel/);
  assert.match(html, /소비자가 \(RETAIL PRICE\)/);
  assert.match(html, /출고가 \(EA당\)/);
  assert.match(html, /주문 단위 · 1/);
  assert.match(html, /최소 주문조건 \(MOQ · EA\)/);
  assert.match(html, /가격이 아니며, 출고가는 EA당 단가/);
  assert.match(html, /프렐류드 상품 ID/);
  assert.match(html, /현재고는 직접 수정하지 않고 입고·출고 원장으로 변경합니다/);
  assert.match(html, /await saveCatalogState\(\);rerenderAll\(\);openDetail/);
  assert.match(html, /beforeOffers=JSON\.parse\(JSON\.stringify\(supplierOffers\)\)/);
  assert.match(html, /supplierOffers=beforeOffers;draftLines=beforeDraftLines/);
  assert.match(html, /if\(!editingOrderId\)draftLines\.filter/);
  assert.match(html, /saveSkuEdit\.setAttribute\('aria-busy','true'\)/);
  assert.match(html, /\.mb-sku-edit-actions > button \{ min-height: 44px; \}/);
});
