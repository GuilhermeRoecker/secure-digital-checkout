const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const axios = require('axios');
if (process.env.DB_NAME !== 'secure_checkout_test') throw new Error('Use apenas o banco isolado secure_checkout_test.');
process.env.NODE_ENV = 'test';
process.env.ASAAS_API_KEY = 'mock-api-key-only';
process.env.ASAAS_BASE_URL = 'https://api-sandbox.asaas.com/v3';
process.env.ASAAS_WEBHOOK_TOKEN = 'mock-webhook-secret-only-'.repeat(2);
process.env.APP_BASE_URL = 'https://checkout.example.invalid';
process.env.DIRECT_PAYMENT_TRUST_CLOUDFLARE = 'true';
const pool = require('../src/config/database');
const repo = require('../src/repositories/orderRepository');
const webhook = require('../src/services/asaasWebhookService');
const { createDirectPayment } = require('../src/services/directPaymentService');
const app = require('../src/app');
const cardNumber = '4' + '1'.repeat(15); // Exemplo fictício do guia oficial, somente em memória dos testes.
const ccv = '9876';
const customer = { name: 'Pessoa Ficticia', email: 'dev@example.invalid', cpfCnpj: '00000000000',
  phone: '00000000000', postalCode: '01310000', address: 'Endereco ficticio', addressNumber: 100, province: 'Centro' };
const card = () => ({ holderName: customer.name, number: cardNumber, ccv, expiryMonth: '12', expiryYear: '2099' });
const deviceInfo = { colorDepth: 24, screenHeight: 900, screenWidth: 1440, timeZoneOffset: 3, language: 'pt-BR' };

// Mock somente no processo de testes. Nenhuma rota MOCK, credencial real ou chamada ao Asaas.
test('DEV MOCK — pagamento direto e 3DS com PostgreSQL real isolado', async t => {
  const originalAdapter = axios.defaults.adapter;
  const originalInfo = console.info;
  const originalError = console.error;
  const logs = [];
  console.info = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  let server;
  t.after(async () => {
    axios.defaults.adapter = originalAdapter;
    console.info = originalInfo;
    console.error = originalError;
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  // Incremento sobre instalação 002 e reaplicação segura da 003.
  const schema = readFileSync('database/schema.sql', 'utf8');
  await pool.query(schema);
  await pool.query(readFileSync('database/migrations/003_direct_3ds.sql', 'utf8'));
  await pool.query(readFileSync('database/migrations/003_direct_3ds.sql', 'utf8'));
  let mode = 'normal';
  const calls = [];
  const reusedCustomer = 'cus_mock_existing';
  axios.defaults.adapter = async config => {
    const url = new URL(config.url);
    const payload = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    calls.push({ path: url.pathname, method: config.method, payload, timeout: config.timeout, params: config.params });
    let data;
    if (url.pathname === '/v3/customers' && config.method === 'get') {
      data = { data: mode === 'new-customer' ? [] : [{ id: reusedCustomer, cpfCnpj: customer.cpfCnpj }] };
    } else if (url.pathname === '/v3/customers') {
      data = { id: 'cus_mock_new' };
    } else if (url.pathname === '/v3/checkouts') {
      data = { id: randomUUID(), link: 'https://sandbox.asaas.com/checkoutSession/show?id=mock' };
    } else if (url.pathname === '/v3/payments') {
      if (mode === 'timeout' || mode === 'refused') {
        const error = new Error(`MOCK must never escape ${cardNumber} ccv=${ccv}`);
        error.config = config;
        error.code = mode === 'timeout' ? 'ECONNABORTED' : 'ERR_BAD_REQUEST';
        if (mode === 'refused') error.response = { status: 400, data: { errors: [{ code: cardNumber, description: error.message }] } };
        throw error;
      }
      data = { id: `pay_${randomUUID()}`, status: 'CONFIRMED',
        threeDSecureChallengeUrl: mode === 'challenge' ? 'https://issuer.example.invalid/challenge?token=mock' : mode === 'bad-url' ? 'javascript:alert(1)' : null,
        creditCard: { number: cardNumber, ccv, creditCardToken: 'mock-sensitive-token' } };
    } else throw new Error('Unexpected MOCK endpoint');
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipCounter = 1;
  async function direct(body, ip = `192.0.2.${ipCounter++}`) {
    return fetch(`${base}/api/payments/direct`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip, 'x-forwarded-proto': 'https' }, body: JSON.stringify(body) });
  }
  const input = () => ({ attemptId: randomUUID(), customer: { ...customer }, creditCard: card(), deviceInfo: { ...deviceInfo } });
  async function serviceCreate(selectedMode = 'normal') {
    mode = selectedMode;
    return createDirectPayment({ publicId: randomUUID(), customer, creditCard: card(), deviceInfo: { ...deviceInfo, userAgent: 'MOCK Browser' }, remoteIp: '192.0.2.100' });
  }
  async function send(publicId, eventType, status, extra = {}) {
    const order = await repo.findOrderByPublicId(publicId);
    const body = { id: `evt_${randomUUID()}&123`, event: eventType, dateCreated: '2026-10-13 12:00:00',
      payment: { id: order.asaas_payment_id, status, billingType: 'CREDIT_CARD',
        creditCard: { number: cardNumber, ccv }, ...extra } };
    const response = await fetch(`${base}/api/webhooks/asaas`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    await webhook.processPendingWebhooks();
    return body;
  }
  let first;
  await t.test('cria pagamento com payload oficial, cliente reutilizado e nenhuma entrega síncrona', async () => {
    const response = await direct(input());
    assert.equal(response.status, 201);
    first = await response.json();
    assert.equal(first.status, 'PENDING');
    assert.equal(first.challengeRequired, false);
    const call = calls.find(c => c.path === '/v3/payments');
    assert.equal(call.payload.customer, reusedCustomer);
    assert.equal(call.payload.value, 100);
    assert.equal(call.payload.billingType, 'CREDIT_CARD');
    assert.equal(call.payload.externalReference, first.orderPublicId);
    assert.equal(call.payload.deviceInfo.timeZoneOffset, 3);
    assert.equal(call.payload.deviceInfo.remoteIp, '192.0.2.1');
    assert.equal(call.payload.remoteIp, '192.0.2.1');
    assert.equal(call.timeout, 65000);
    assert.equal(call.payload.threeDSecure.callbackUrl, `${process.env.APP_BASE_URL}/payments/3ds/callback?order=${first.orderPublicId}`);
    assert.ok(!calls.some(c => c.path === '/v3/customers' && c.method === 'post'));
    assert.equal((await repo.findOrderByPublicId(first.orderPublicId, { includeDeliveryCode: true })).delivery_code, null);
  });
  await t.test('PAYMENT_CREATED e callback não liberam; webhook financeiro libera uma vez', async () => {
    await send(first.orderPublicId, 'PAYMENT_CREATED', 'CONFIRMED');
    assert.equal((await repo.findOrderByPublicId(first.orderPublicId)).status, 'PENDING');
    assert.equal((await repo.listEvents(first.orderPublicId)).filter(e => e.event_type === 'PAYMENT_PENDING').length, 1);
    assert.equal((await fetch(`${base}/payments/3ds/callback?order=${first.orderPublicId}`)).status, 200);
    assert.equal((await repo.findOrderByPublicId(first.orderPublicId)).status, 'PENDING');
    const event = await send(first.orderPublicId, 'PAYMENT_CONFIRMED', 'CONFIRMED');
    const released = await repo.findOrderByPublicId(first.orderPublicId, { includeDeliveryCode: true });
    assert.equal(released.status, 'CONFIRMED');
    assert.match(released.delivery_code, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
    const results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/webhooks/asaas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'asaas-access-token': process.env.ASAAS_WEBHOOK_TOKEN }, body: JSON.stringify(event)
    })));
    assert.ok(results.every(r => r.status === 200));
    await send(first.orderPublicId, 'PAYMENT_RECEIVED', 'RECEIVED');
    await send(first.orderPublicId, 'PAYMENT_CREATED', 'PENDING');
    await send(first.orderPublicId, 'PAYMENT_AWAITING_RISK_ANALYSIS', 'AWAITING_RISK_ANALYSIS');
    const final = await repo.findOrderByPublicId(first.orderPublicId, { includeDeliveryCode: true });
    assert.equal(final.status, 'CONFIRMED');
    assert.equal(final.delivery_code, released.delivery_code);
    const events = await repo.listEvents(first.orderPublicId);
    assert.equal(events.filter(e => e.event_type === 'PAYMENT_CONFIRMED').length, 1);
    assert.equal(events.filter(e => e.event_type === 'DELIVERY_RELEASED').length, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM digital_deliveries WHERE order_id=$1', [final.id])).rows[0].n, 1);
  });
  await t.test('recusa e falha 3DS bloqueiam, inclusive contra confirmação tardia', async () => {
    for (const event of ['PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', 'PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED']) {
      const result = await serviceCreate();
      await send(result.publicId, event, 'PENDING');
      await send(result.publicId, 'PAYMENT_CONFIRMED', 'CONFIRMED');
      const order = await repo.findOrderByPublicId(result.publicId, { includeDeliveryCode: true });
      assert.equal(order.status, 'REFUSED');
      assert.equal(order.delivery_code, null);
      assert.equal(order.delivery_status, 'BLOCKED');
    }
  });
  await t.test('estorno após entrega bloqueia leitura e não permite segunda liberação', async () => {
    const result = await serviceCreate();
    await send(result.publicId, 'PAYMENT_CONFIRMED', 'CONFIRMED');
    const before = await repo.findOrderByPublicId(result.publicId, { includeDeliveryCode: true });
    await send(result.publicId, 'PAYMENT_REFUNDED', 'REFUNDED');
    await send(result.publicId, 'PAYMENT_CONFIRMED', 'CONFIRMED');
    const after = await repo.findOrderByPublicId(result.publicId, { includeDeliveryCode: true });
    assert.equal(after.status, 'CANCELED');
    assert.equal(after.delivery_status, 'BLOCKED');
    assert.equal(after.delivery_code, null);
    const stored = await pool.query('SELECT delivery_code FROM digital_deliveries WHERE order_id=$1', [after.id]);
    assert.equal(stored.rows[0].delivery_code, before.delivery_code);
  });
  await t.test('challenge HTTPS retornado; URL insegura descartada; cliente novo quando necessário', async () => {
    const challenge = await serviceCreate('challenge');
    assert.equal(challenge.challengeUrl, 'https://issuer.example.invalid/challenge?token=mock');
    assert.equal(challenge.status, 'PENDING');
    assert.ok((await repo.listEvents(challenge.publicId)).some(e => e.event_type === 'THREE_DS_CHALLENGE_REQUIRED'));
    const bad = await serviceCreate('bad-url');
    assert.equal(bad.challengeUrl, null);
    assert.equal(bad.errorType, 'ASAAS_INVALID_CHALLENGE');
    const fresh = await serviceCreate('new-customer');
    assert.equal(fresh.status, 'PENDING');
    assert.ok(calls.some(c => c.path === '/v3/customers' && c.method === 'post'));
  });
  await t.test('timeout não repete cobrança; erros do provedor não vazam dados sensíveis', async () => {
    for (const selectedMode of ['timeout', 'refused']) {
      mode = selectedMode;
      const body = input();
      const before = calls.filter(c => c.path === '/v3/payments').length;
      const response = await direct(body);
      assert.equal(response.status, 422);
      const result = await response.json();
      assert.equal(result.status, selectedMode === 'timeout' ? 'UNDER_REVIEW' : 'REFUSED');
      assert.ok(!JSON.stringify(result).includes(cardNumber));
      mode = 'normal';
      await direct(body);
      assert.equal(calls.filter(c => c.path === '/v3/payments').length, before + 1);
    }
  });
  await t.test('mesma tentativa concorrente faz um único POST payments', async () => {
    mode = 'normal';
    const body = input();
    const before = calls.filter(c => c.path === '/v3/payments').length;
    const responses = await Promise.all([direct(body), direct(body)]);
    assert.ok(responses.every(r => r.status === 201));
    assert.equal(calls.filter(c => c.path === '/v3/payments').length, before + 1);
  });
  await t.test('headers de proxy só são aceitos com peer local e opt-in, IP inválido rejeitado', async () => {
    const { payerConnection, requireDirectHttps } = require('../src/middleware/directPaymentSecurity');
    const headers = { 'cf-connecting-ip': '192.0.2.1', 'x-forwarded-proto': 'https' };
    const req = { socket: { remoteAddress: '198.51.100.10' }, secure: false, get: name => headers[name] };
    assert.deepEqual(payerConnection(req), { ip: '198.51.100.10', https: false });
    req.socket.remoteAddress = '127.0.0.1';
    assert.deepEqual(payerConnection(req), { ip: '192.0.2.1', https: true });
    headers['cf-connecting-ip'] = 'invalid';
    let rejected = null;
    requireDirectHttps(req, { status(code) { rejected = code; return this; }, json() {} }, () => assert.fail('IP inválido não deve ser aceito'));
    assert.equal(rejected, 400);
  });
  await t.test('JSON inválido, limite de tentativas e autenticação do webhook continuam seguros', async () => {
    const invalid = await fetch(`${base}/api/payments/direct`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.199', 'x-forwarded-proto': 'https' }, body: `{"creditCard":"${cardNumber}"` });
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes(cardNumber));
    for (let i = 0; i < 5; i++) assert.equal((await direct({}, '192.0.2.200')).status, 400);
    assert.equal((await direct({}, '192.0.2.200')).status, 429);
    const badToken = await fetch(`${base}/api/webhooks/asaas`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'asaas-access-token': 'invalid' }, body: '{}' });
    assert.equal(badToken.status, 401);
    // O rate limiter é exclusivo do cartão, sem afetar callbacks ou webhook.
    assert.equal((await fetch(`${base}/payments/3ds/callback`)).status, 200);
  });
  await t.test('checkout hospedado existente cria checkout e entrega pelo webhook original', async () => {
    mode = 'normal';
    const response = await fetch(`${base}/api/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(customer) });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.match(created.checkoutUrl, /^https:\/\/sandbox.asaas.com\//);
    const order = await repo.findOrderByPublicId(created.order.publicId);
    assert.equal(order.payment_flow, 'HOSTED_CHECKOUT');
    assert.equal(order.status, 'CHECKOUT_CREATED');
    await webhook.processAsaasWebhook({ id: `evt_${randomUUID()}`, event: 'CHECKOUT_PAID', checkout: { id: order.asaas_checkout_id, status: 'PAID' } });
    await webhook.processPendingWebhooks();
    assert.equal((await repo.findOrderByPublicId(order.public_id)).status, 'CONFIRMED');
    const payload = calls.find(c => c.path === '/v3/checkouts').payload;
    assert.deepEqual(payload.billingTypes, ['CREDIT_CARD']);
    assert.deepEqual(payload.chargeTypes, ['DETACHED']);
    assert.ok(!payload.creditCard);
  });
  await t.test('persistência, logs e respostas admin não contêm PAN, CVV ou tokens', async () => {
    for (const table of ['orders', 'order_events', 'webhook_events', 'digital_deliveries']) {
      // Identificadores da lista fixa acima, sem entrada do usuário.
      const result = await pool.query(`SELECT row_to_json(t) AS data FROM ${table} t`);
      const raw = JSON.stringify(result.rows);
      assert.ok(!raw.includes(cardNumber));
      assert.ok(!raw.includes('"ccv"'));
      assert.ok(!raw.includes('mock-sensitive-token'));
      assert.ok(!raw.includes('issuer.example.invalid'));
    }
    const admin = await (await fetch(`${base}/api/admin/orders/${first.orderPublicId}`)).json();
    assert.equal(admin.order.delivery_code, null);
    assert.ok(!JSON.stringify(admin).includes(cardNumber));
    const safeLogs = logs.join('\n');
    for (const secret of [cardNumber, 'mock-sensitive-token', process.env.ASAAS_API_KEY, process.env.ASAAS_WEBHOOK_TOKEN]) assert.ok(!safeLogs.includes(secret));
    assert.ok(!safeLogs.includes(`ccv=${ccv}`));
    assert.ok(!safeLogs.includes('"ccv"'));
  });
});
