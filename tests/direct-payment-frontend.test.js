const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

test('DEV MOCK — frontend limpa cartão e encaminha somente challenge HTTPS do backend', async () => {
  const nodes = new Map();
  const callbacks = new Map();
  const ids = ['direct-payment-form', 'buy-button', 'direct-payment-result', 'direct-payment-message',
    'direct-order-link', 'direct-challenge-link', 'holderName', 'cardNumber', 'expiryMonth', 'expiryYear', 'ccv'];
  for (const id of ids) nodes.set(id, { value: '', hidden: true, setAttribute() {}, removeAttribute() {},
    addEventListener(type, fn) { callbacks.set(type, fn); } });
  const syntheticCard = '4' + '1'.repeat(15);
  nodes.get('holderName').value = 'Pessoa Ficticia';
  nodes.get('cardNumber').value = syntheticCard;
  nodes.get('expiryMonth').value = '12';
  nodes.get('expiryYear').value = '2099';
  nodes.get('ccv').value = '9876';
  let redirected = null;
  let sent;
  const result = { success: true, challengeRequired: true, challengeUrl: 'https://issuer.example.invalid/challenge' };
  const context = {
    document: { querySelector: selector => nodes.get(selector.slice(1)), getElementById: id => nodes.get(id) },
    window: { crypto: { randomUUID }, screen: { colorDepth: 24, height: 900, width: 1440 },
      location: { assign: url => { redirected = url; } }, addEventListener() {} },
    navigator: { language: 'pt-BR' }, Date, URL,
    FormData: class { entries() { return [['name', 'Pessoa Ficticia']]; } },
    async fetch(url, request) {
      assert.equal(url, '/api/payments/direct');
      assert.equal(nodes.get('cardNumber').value, '');
      assert.equal(nodes.get('ccv').value, '');
      sent = JSON.parse(request.body);
      return { ok: true };
    },
    readApiJsonResponse: async () => result
  };
  vm.runInNewContext(readFileSync('src/public/js/direct-payment.js', 'utf8'), context);
  await callbacks.get('submit')({ preventDefault() {} });
  assert.equal(sent.creditCard.number, syntheticCard);
  assert.equal(sent.deviceInfo.colorDepth, 24);
  assert.equal(redirected, result.challengeUrl);
  assert.equal(nodes.get('cardNumber').value, '');
  assert.equal(nodes.get('ccv').value, '');
  assert.equal(nodes.get('buy-button').disabled, true);
  assert.ok(!readFileSync('src/public/js/direct-payment.js', 'utf8').includes('localStorage'));
});
