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

test('발주 실행 모달은 이메일 초안 대신 발주 완료 동작을 제공한다', () => {
  assert.match(html, /id="mb-complete-order"[^>]*>발주 완료<\/button>/);
  assert.match(html, /#mb-complete-order'\)\.addEventListener\('click'/);
  assert.match(html, /confirmOrder\(pendingExecuteOrderId,\{closeExecute:true\}\)/);
  assert.doesNotMatch(html, /mb-email-order|메일 초안 준비|finishExecute\(pendingExecuteOrderId,'EMAIL'/);
});

test('발주 준비와 완료 상세 모두 다운로드를 제공하고 완료 상태에서는 완료 CTA를 숨긴다', () => {
  const builderStart = html.indexOf('function renderOrderBuilder');
  const builderEnd = html.indexOf('function validateDraft', builderStart);
  const builderSource = html.slice(builderStart, builderEnd);
  assert.match(builderSource, /order\.status==='ORDERED'.*data-order-execute=.*발주서 다운로드.*data-order-confirm=.*발주 완료/s);
  assert.match(builderSource, /order\.status==='CONFIRMED'.*data-order-execute=.*발주서 다운로드.*mb-save-order-revision.*입고 완료/s);

  const executeStart = html.indexOf('function openExecuteOrder');
  const executeEnd = html.indexOf('function finishExecute', executeStart);
  const executeSource = html.slice(executeStart, executeEnd);
  assert.match(executeSource, /canComplete=order\.status==='ORDERED'/);
  assert.match(executeSource, /completeButton\.hidden=!canComplete/);
  assert.match(executeSource, /저장된 발주 품목과 양식 버전으로 발주서를 다시 받을 수 있습니다/);
});

test('발주 목록도 준비와 완료를 구분하고 준비 상태의 입고 우회를 막는다', () => {
  const start = html.indexOf('function renderOrders');
  const end = html.indexOf('function renderSuppliers', start);
  const source = html.slice(start, end);
  assert.match(source, /발주 준비 \/ 완료/);
  assert.match(source, /pendingQty = confirmed\.reduce/);
  assert.match(source, /order\.status==='ORDERED'.*data-order-confirm=.*발주 완료/);
  assert.match(source, /order\.status==='CONFIRMED'.*data-order-receive=.*입고 완료/);
});

function completionHarness({ rejectSave = false } = {}) {
  const start = html.indexOf('async function confirmOrder');
  const end = html.indexOf('async function cancelOrder', start);
  const source = html.slice(start, end);
  const orders = [{
    id: 'PO-TEST-001', supplierId: 'SUP-1', status: 'ORDERED', revision: 1,
    templateVersion: 1, templateSnapshot: { sheetBindings: [] },
    lines: [{ sku: 'SKU-1', orderUnits: 2, confirmedOrderUnits: null, qty: 4, confirmedQty: null }],
  }];
  const items = [{ id: 'SKU-1', incoming: 1, stock: 5 }];
  const closed = [];
  const messages = [];
  let saves = 0;
  let localRollbacks = 0;
  const confirmOrder = new Function(
    'orders', 'items', 'editingOrderId', 'root', 'findOrder', 'findItem', 'findOffer',
    'lineOrderUnits', 'validateDraft', 'findSupplier', 'draftLines', 'buildOrderLineSnapshot',
    'outputTargetsFromOrderLines', 'orderTimestamp', 'saveCatalogState', 'saveCatalogStateLocal',
    'closeOverlay', 'rerenderAll', 'showToast',
    `${source}; return confirmOrder;`,
  )(
    orders, items, null,
    { querySelector: () => ({ classList: { contains: () => false } }) },
    (id) => orders.find((order) => order.id === id),
    (sku) => items.find((item) => item.id === sku),
    () => ({ unitsPerOrder: 2 }),
    (line) => line.orderUnits,
    () => true,
    () => ({ id: 'SUP-1' }),
    [],
    () => { throw new Error('not used'); },
    () => [],
    () => '2026.08.27 18:00',
    async () => { saves += 1; if (rejectSave) throw new Error('remote failed'); },
    async () => { localRollbacks += 1; },
    (id) => closed.push(id),
    () => {},
    (message) => messages.push(message),
  );
  return { confirmOrder, orders, items, closed, messages, getSaves: () => saves, getLocalRollbacks: () => localRollbacks };
}

test('발주 완료는 ORDERED를 한 번만 CONFIRMED로 바꾸고 입고 예정 수량을 반영한다', async () => {
  const harness = completionHarness();
  assert.equal(await harness.confirmOrder('PO-TEST-001', { closeExecute: true }), true);
  assert.equal(harness.orders[0].status, 'CONFIRMED');
  assert.equal(harness.orders[0].confirmedAt, '2026.08.27 18:00');
  assert.equal(harness.orders[0].lines[0].confirmedOrderUnits, 2);
  assert.equal(harness.orders[0].lines[0].confirmedQty, 4);
  assert.equal(harness.items[0].incoming, 5);
  assert.deepEqual(harness.closed, ['mb-execute-overlay', 'mb-order-overlay']);
  assert.equal(harness.getSaves(), 1);

  assert.equal(await harness.confirmOrder('PO-TEST-001', { closeExecute: true }), false);
  assert.equal(harness.items[0].incoming, 5);
  assert.equal(harness.getSaves(), 1);
});

test('발주 완료 저장 실패 시 주문과 입고 예정 수량을 원상복구하고 모달을 유지한다', async () => {
  const harness = completionHarness({ rejectSave: true });
  assert.equal(await harness.confirmOrder('PO-TEST-001', { closeExecute: true }), false);
  assert.equal(harness.orders[0].status, 'ORDERED');
  assert.equal(harness.orders[0].confirmedAt, undefined);
  assert.equal(harness.orders[0].lines[0].confirmedOrderUnits, null);
  assert.equal(harness.orders[0].lines[0].confirmedQty, null);
  assert.equal(harness.items[0].incoming, 1);
  assert.deepEqual(harness.closed, []);
  assert.equal(harness.getLocalRollbacks(), 1);
  assert.match(harness.messages.at(-1), /remote failed/);
});

test('완료 후 재다운로드에 필요한 상품과 브랜드 값은 주문 스냅샷을 우선한다', () => {
  const snapshotStart = html.indexOf('function buildOrderLineSnapshot');
  const snapshotEnd = html.indexOf('function outputTargetsFromOrderLines', snapshotStart);
  const snapshotSource = html.slice(snapshotStart, snapshotEnd);
  assert.match(snapshotSource, /productId:item\.productId/);
  assert.match(snapshotSource, /brandName:scope/);

  const exportStart = html.indexOf('function orderExportRows');
  const exportEnd = html.indexOf('function orderTableValues', exportStart);
  const exportSource = html.slice(exportStart, exportEnd);
  assert.match(exportSource, /productId:snapshot\.productId\|\|item/);
  assert.match(exportSource, /brand:excelSafeText\(snapshot\.brandName\|\|snapshot\.scopeName/);
  assert.match(exportSource, /storedUnits=order\.status==='CONFIRMED'.*line\.confirmedOrderUnits/s);
});
