const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');

// DEV: banco descartável separado. Não lê .env nem chama o Asaas.
if (process.env.DB_NAME !== 'secure_checkout_test') {
  throw new Error('Use exclusivamente DB_NAME=secure_checkout_test em um PostgreSQL isolado.');
}
process.env.ASAAS_WEBHOOK_TOKEN = 'test-only-webhook-token-'.repeat(3);
const pool = require('../src/config/database');
const repo = require('../src/repositories/orderRepository');
const service = require('../src/services/asaasWebhookService');
const app = require('../src/app');

test('DEV — webhook com PostgreSQL real isolado', async (t) => {
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  const schema = readFileSync('database/schema.sql', 'utf8');
  // Instalação legada: só orders/order_events; preserva pedido durante migração.
  await pool.query(schema.slice(0, schema.indexOf('CREATE INDEX IF NOT EXISTS orders_asaas_checkout_id_idx')));
  const legacy = randomUUID();
  await pool.query(`INSERT INTO orders (public_id, customer_name, customer_email,
    customer_document, customer_phone, product_name, amount)
    VALUES ($1, 'Pessoa Fictícia', 'dev@example.invalid', '00000000000', '00000000000', 'Gift Card', 100)`, [legacy]);
  for (const file of ['database/migrations/001_webhook_delivery.sql', 'database/migrations/002_webhook_worker.sql', 'database/schema.sql']) {
    await pool.query(readFileSync(file, 'utf8'));
    await pool.query(readFileSync(file, 'utf8'));
  }
  assert.equal((await repo.findOrderByPublicId(legacy)).status, 'CREATED');
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(body, token = process.env.ASAAS_WEBHOOK_TOKEN) {
    return fetch(`${base}/api/webhooks/asaas`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'asaas-access-token': token
    }, body: JSON.stringify(body) });
  }
  async function order() {
    const publicId = randomUUID();
    await repo.createOrder({ publicId, customer: { name: 'Nome Sigiloso', email: 'dev@example.invalid',
      cpfCnpj: '00000000000', phone: '00000000000' }, productName: 'Gift Card', amount: 100 });
    const checkoutId = randomUUID();
    await repo.markCheckoutCreated(publicId, { id: checkoutId, link: 'https://sandbox.asaas.com/test' });
    return { publicId, checkoutId };
  }
  function event(o, type, status) { return { id: `evt_${randomUUID()}&123`, event: type, checkout: { id: o.checkoutId, status } }; }
  const initialEvents = (await pool.query('SELECT COUNT(*)::int AS n FROM webhook_events')).rows[0].n;
  const o = await order();
  const paid = event(o, 'CHECKOUT_PAID', 'PAID');
  await t.test('autenticação, validação e callbacks sem efeito financeiro', async () => {
    assert.equal((await post(paid, '')).status, 401);
    assert.equal((await post(paid, 'wrong')).status, 401);
    assert.equal((await post({})).status, 400);
    for (const path of ['success', 'cancel']) assert.equal((await fetch(`${base}/checkout/${path}?order=${o.publicId}`)).status, 200);
    assert.equal((await repo.findOrderByPublicId(o.publicId)).status, 'CHECKOUT_CREATED');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM webhook_events')).rows[0].n, initialEvents);
  });
  await t.test('pendente bloqueado; confirmação persiste antes de processar', async () => {
    assert.equal((await post(event(o, 'CHECKOUT_CREATED', 'ACTIVE'))).status, 200);
    await service.processPendingWebhooks();
    const before = await (await fetch(`${base}/api/orders/${o.publicId}`)).json();
    assert.equal(before.order.status, 'PENDING');
    assert.equal(before.order.deliveryCode, null);
    assert.equal((await post(paid)).status, 200);
    assert.equal((await repo.findOrderByPublicId(o.publicId)).status, 'PENDING');
    await service.processPendingWebhooks();
    const response = await fetch(`${base}/api/orders/${o.publicId}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const after = await response.json();
    assert.equal(after.order.status, 'CONFIRMED');
    assert.match(after.order.deliveryCode, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
  });
  const original = (await repo.findOrderByPublicId(o.publicId, { includeDeliveryCode: true })).delivery_code;
  await t.test('reenvios concorrentes e IDs diferentes não duplicam entrega/eventos', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post(paid)));
    assert.ok(results.every(r => r.status === 200));
    await Promise.all(Array.from({ length: 4 }, () => post(event(o, 'CHECKOUT_PAID', 'PAID'))));
    await Promise.all([service.processPendingWebhooks(), service.processPendingWebhooks()]);
    const events = await repo.listEvents(o.publicId);
    for (const type of ['PAYMENT_CONFIRMED', 'DELIVERY_RELEASED', 'PAYMENT_PENDING']) {
      assert.equal(events.filter(e => e.event_type === type).length, 1);
    }
    assert.equal((await repo.findOrderByPublicId(o.publicId, { includeDeliveryCode: true })).delivery_code, original);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM digital_deliveries d JOIN orders o ON o.id=d.order_id WHERE o.public_id=$1', [o.publicId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM webhook_events WHERE provider_event_id=$1', [paid.id])).rows[0].n, 1);
  });
  await t.test('evento tardio não regride confirmação; desconhecido ignorado', async () => {
    await post(event(o, 'CHECKOUT_CANCELED', 'CANCELED'));
    const unknown = event(o, 'FUTURE_EVENT', 'PAID');
    await post(unknown);
    await post(event(o, 'CHECKOUT_CREATED', 'ACTIVE'));
    await service.processPendingWebhooks();
    assert.equal((await repo.findOrderByPublicId(o.publicId)).status, 'CONFIRMED');
    assert.equal((await pool.query('SELECT status FROM webhook_events WHERE provider_event_id=$1', [unknown.id])).rows[0].status, 'IGNORED');
  });
  await t.test('cancelamento, expiração e payload inconsistente nunca liberam', async () => {
    for (const [type, status] of [['CHECKOUT_CANCELED', 'CANCELED'], ['CHECKOUT_EXPIRED', 'EXPIRED'], ['CHECKOUT_PAID', 'ACTIVE']]) {
      const blocked = await order();
      await post(event(blocked, type, status));
      await service.processPendingWebhooks();
      const row = await repo.findOrderByPublicId(blocked.publicId, { includeDeliveryCode: true });
      assert.notEqual(row.status, 'CONFIRMED');
      assert.equal(row.delivery_code, null);
      assert.equal(row.delivery_status, 'BLOCKED');
    }
  });
  await t.test('falha na entrega reverte status/timeline; retry recupera sem perda', async () => {
    const broken = await order();
    const body = event(broken, 'CHECKOUT_PAID', 'PAID');
    await post(body);
    const normalized = (await repo.listPendingWebhooks()).find(e => e.id === body.id);
    await assert.rejects(repo.processAsaasWebhook(normalized, service.CHECKOUT_TRANSITIONS.CHECKOUT_PAID, () => { throw new Error('DEV injected failure'); }));
    assert.equal((await repo.findOrderByPublicId(broken.publicId)).status, 'CHECKOUT_CREATED');
    assert.equal((await repo.listEvents(broken.publicId)).filter(e => e.event_type === 'PAYMENT_CONFIRMED').length, 0);
    assert.equal((await pool.query('SELECT status FROM webhook_events WHERE provider_event_id=$1', [body.id])).rows[0].status, 'RECEIVED');
    await service.processPendingWebhooks();
    assert.equal((await repo.findOrderByPublicId(broken.publicId)).status, 'CONFIRMED');
  });
  await t.test('evento anterior ao vínculo do checkout permanece recuperável', async () => {
    const early = { checkoutId: randomUUID(), publicId: legacy };
    const body = event(early, 'CHECKOUT_PAID', 'PAID');
    await post(body);
    await service.processPendingWebhooks();
    assert.equal((await pool.query('SELECT status FROM webhook_events WHERE provider_event_id=$1', [body.id])).rows[0].status, 'RECEIVED');
    await repo.markCheckoutCreated(legacy, { id: early.checkoutId, link: 'https://sandbox.asaas.com/test' });
    await pool.query('UPDATE webhook_events SET next_attempt_at=NOW() WHERE provider_event_id=$1', [body.id]);
    await service.processPendingWebhooks();
    assert.equal((await repo.findOrderByPublicId(legacy)).status, 'CONFIRMED');
  });
  await t.test('admin não retorna nome pessoal ou código; dupla condição de entrega', async () => {
    const admin = await (await fetch(`${base}/api/admin/orders/${o.publicId}`)).json();
    assert.equal(admin.order.customer_name, 'Oculto');
    assert.equal(admin.order.delivery_code, null);
    const listing = await (await fetch(`${base}/api/admin/orders`)).text();
    assert.ok(!listing.includes('Nome Sigiloso'));
    await pool.query("UPDATE orders SET status='PENDING' WHERE public_id=$1", [o.publicId]);
    assert.equal((await repo.findOrderByPublicId(o.publicId, { includeDeliveryCode: true })).delivery_code, null);
    await pool.query("UPDATE orders SET status='CONFIRMED' WHERE public_id=$1", [o.publicId]);
    await pool.query("UPDATE digital_deliveries SET status='BLOCKED' WHERE order_id=(SELECT id FROM orders WHERE public_id=$1)", [o.publicId]);
    assert.equal((await repo.findOrderByPublicId(o.publicId, { includeDeliveryCode: true })).delivery_code, null);
  });
});
