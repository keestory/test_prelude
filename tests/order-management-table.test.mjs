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

test('발주 관리 표는 요청한 9개 컬럼을 요청 순서대로 표시한다', () => {
  assert.match(
    html,
    /<table class="mb-order-table" aria-label="발주서 목록"><thead><tr><th>발주 번호<\/th><th>발주일<\/th><th>입고일<\/th><th>발주처<\/th><th>브랜드·컬렉션<\/th><th>수량<\/th><th>발주 금액<\/th><th>상태<\/th><th>기타<\/th>/,
  );
  assert.match(html, /<td colspan="9"><div class="mb-empty">/);
  assert.doesNotMatch(html, /발주번호 \/ 상태<\/th>/);
  assert.doesNotMatch(html, /문서 버전<\/th>/);
});

test('목록 상태는 내부 발주 단계를 3개의 사용자 상태로 합친다', () => {
  const start = html.indexOf('function orderStatusGroup');
  const end = html.indexOf('function orderLineQty', start);
  const source = html.slice(start, end);
  const helpers = new Function(`${source}; return { orderStatusGroup, orderStatusLabel };`)();

  assert.equal(helpers.orderStatusGroup('ORDERED'), 'ORDER_COMPLETE');
  assert.equal(helpers.orderStatusGroup('CONFIRMED'), 'ORDER_COMPLETE');
  assert.equal(helpers.orderStatusLabel('ORDERED'), '발주 완료');
  assert.equal(helpers.orderStatusLabel('CONFIRMED'), '발주 완료');
  assert.equal(helpers.orderStatusLabel('RECEIVED'), '입고 완료');
  assert.equal(helpers.orderStatusLabel('CANCELLED'), '발주 취소');
  assert.match(html, /<option value="ORDER_COMPLETE">발주 완료<\/option><option value="RECEIVED">입고 완료<\/option><option value="CANCELLED">발주 취소<\/option>/);
});

test('기타 컬럼은 상태별로 입고 완료와 발주 취소만 노출한다', () => {
  const start = html.indexOf('function renderOrders');
  const end = html.indexOf('function renderSuppliers', start);
  const source = html.slice(start, end);
  assert.match(source, /data-order-receive=.*입고 완료/);
  assert.match(source, /data-order-cancel=.*발주 취소/);
  assert.match(source, /order\.status==='RECEIVED'.*data-order-cancel/);
  assert.match(source, /order\.status==='RECEIVED'\?'<button[^']+data-order-cancel/);
  assert.doesNotMatch(source, />발주 확정<\/button>/);
});

function transitionHarness(initialOrder, initialItem) {
  const start = html.indexOf('async function cancelOrder');
  const end = html.indexOf('function openExecuteOrder', start);
  const source = html.slice(start, end);
  const orders = [structuredClone(initialOrder)];
  const items = [structuredClone(initialItem)];
  const movements = [];
  const messages = [];
  return new Function(
    'orders',
    'items',
    'movements',
    'findOrder',
    'findItem',
    'findOffer',
    'lineOrderUnits',
    'lineInventoryUnitCost',
    'orderLineQty',
    'orderQty',
    'orderTimestamp',
    'saveCatalogState',
    'closeOverlay',
    'rerenderAll',
    'showToast',
    'messages',
    `${source}; return { cancelOrder, receiveOrder, orders, items, messages, getMovements: () => movements };`,
  )(
    orders,
    items,
    movements,
    (id) => orders.find((order) => order.id === id),
    (sku) => items.find((item) => item.id === sku),
    () => ({ unitsPerOrder: 1, minOrderUnits: 1 }),
    () => 3,
    (line) => line.amountBasis === 'RETAIL_PRICE_FALLBACK' ? null : Number(line.unitCost) > 0 ? Number(line.unitCost) : null,
    (_order, line) => line.confirmedQty == null ? line.qty : line.confirmedQty,
    (order) => order.lines.reduce((sum, line) => sum + (line.confirmedQty == null ? line.qty : line.confirmedQty), 0),
    () => '2026.08.27 16:30',
    async () => {},
    () => {},
    () => {},
    (message) => messages.push(message),
    messages,
  );
}

test('발주 완료에서 입고 완료로 한 번에 전환하며 재고와 입고 원장을 반영한다', async () => {
  const harness = transitionHarness(
    { id: 'PO-TEST-001', supplierId: 'SUP-TEST', status: 'ORDERED', stockPosted: false, lines: [{ sku: 'SKU-1', qty: 3, orderUnits: 3, unitCost: 1000 }] },
    { id: 'SKU-1', stock: 2, incoming: 0, inPeriod: 0, reserved: 0 },
  );

  await harness.receiveOrder('PO-TEST-001');
  assert.equal(harness.orders[0].status, 'RECEIVED', harness.messages.join(' / '));
  assert.equal(harness.orders[0].receivedAt, '2026.08.27 16:30');
  assert.equal(harness.items[0].stock, 5);
  assert.equal(harness.items[0].incoming, 0);
  assert.equal(harness.getMovements()[0].type, 'PURCHASE_IN');
  assert.equal(harness.getMovements()[0].cost, 1000);
});

test('소비자가 기준 발주를 입고해도 소비자가를 매입원가로 원장에 쓰지 않는다', async () => {
  const harness = transitionHarness(
    {
      id: 'PO-TEST-RETAIL',
      supplierId: 'SUP-TEST',
      status: 'ORDERED',
      stockPosted: false,
      lines: [{ sku: 'SKU-1', qty: 36, orderUnits: 3, unitPrice: 1500, unitCost: 0, amountBasis: 'RETAIL_PRICE_FALLBACK' }],
    },
    { id: 'SKU-1', stock: 2, incoming: 0, inPeriod: 0, reserved: 0 },
  );

  await harness.receiveOrder('PO-TEST-RETAIL');
  assert.equal(harness.orders[0].status, 'RECEIVED', harness.messages.join(' / '));
  assert.equal(harness.getMovements()[0].cost, null);
});

test('입고 완료 발주 취소는 입고일을 보존하고 재고를 취소 원장으로 되돌린다', async () => {
  const harness = transitionHarness(
    { id: 'PO-TEST-002', supplierId: 'SUP-TEST', status: 'ORDERED', stockPosted: false, lines: [{ sku: 'SKU-1', qty: 3, orderUnits: 3, unitCost: 1000 }] },
    { id: 'SKU-1', stock: 2, incoming: 0, inPeriod: 0, reserved: 0 },
  );

  await harness.receiveOrder('PO-TEST-002');
  assert.equal(harness.orders[0].status, 'RECEIVED', harness.messages.join(' / '));
  const receivedAt = harness.orders[0].receivedAt;
  await harness.cancelOrder('PO-TEST-002');

  assert.equal(harness.orders[0].status, 'CANCELLED');
  assert.equal(harness.orders[0].receivedAt, receivedAt);
  assert.equal(harness.orders[0].cancelledFrom, 'RECEIVED');
  assert.equal(harness.orders[0].receiptReversed, true);
  assert.equal(harness.items[0].stock, 2);
  assert.equal(harness.items[0].inPeriod, 0);
  assert.equal(harness.getMovements()[0].type, 'REVERSAL');
  assert.equal(harness.getMovements()[0].direction, 'OUT');
  assert.match(harness.getMovements()[0].reversesMovementId, /^PO_RECEIPT:/);

  const movementCount = harness.getMovements().length;
  await harness.cancelOrder('PO-TEST-002');
  assert.equal(harness.getMovements().length, movementCount);
  assert.equal(harness.items[0].stock, 2);
});
