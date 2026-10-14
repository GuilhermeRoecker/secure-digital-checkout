const { randomBytes, randomUUID } = require('node:crypto');
const orderRepository = require('../repositories/orderRepository');

// Checkout hospedado: mapeamento preservado. Pagamentos diretos usam seu próprio ID e transições abaixo.
const CHECKOUT_TRANSITIONS = Object.freeze({
  CHECKOUT_CREATED: {
    checkoutStatus: 'ACTIVE',
    orderStatus: 'PENDING',
    orderEventType: 'PAYMENT_PENDING',
    orderEventDescription: 'Checkout ativo; aguardando confirmação financeira do Asaas.'
  },
  CHECKOUT_PAID: {
    checkoutStatus: 'PAID',
    orderStatus: 'CONFIRMED',
    orderEventType: 'PAYMENT_CONFIRMED',
    orderEventDescription: 'Pagamento confirmado pelo evento CHECKOUT_PAID do Asaas.'
  },
  CHECKOUT_CANCELED: {
    checkoutStatus: 'CANCELED',
    orderStatus: 'CANCELED',
    orderEventType: 'CHECKOUT_CANCELED',
    orderEventDescription: 'Checkout cancelado no Asaas.'
  },
  CHECKOUT_EXPIRED: {
    checkoutStatus: 'EXPIRED',
    orderStatus: 'EXPIRED',
    orderEventType: 'CHECKOUT_EXPIRED',
    orderEventDescription: 'Checkout expirado no Asaas.'
  }
});

// Eventos oficiais: /docs/criar-cobrança-com-3ds e /docs/webhook-para-cobrancas.
// Falhas não exigem payment.status específico: o evento informa a falha, e a cobrança pode continuar PENDING.
function paymentTransition(orderStatus, orderEventType, description, extra = {}) {
  return { resource: 'payment', orderStatus, orderEventType, orderEventDescription: description, ...extra };
}
const PAYMENT_TRANSITIONS = Object.freeze({
  PAYMENT_CREATED: paymentTransition('PENDING', 'PAYMENT_PENDING', 'Cobrança criada; aguardando confirmação.'),
  PAYMENT_CONFIRMED: paymentTransition('CONFIRMED', 'PAYMENT_CONFIRMED', 'Captura confirmada.', { paymentStatus: 'CONFIRMED' }),
  PAYMENT_RECEIVED: paymentTransition('CONFIRMED', 'PAYMENT_CONFIRMED', 'Pagamento recebido.', { paymentStatus: 'RECEIVED' }),
  PAYMENT_AWAITING_RISK_ANALYSIS: paymentTransition('UNDER_REVIEW', 'PAYMENT_UNDER_REVIEW', 'Pagamento em análise de risco.'),
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: paymentTransition('REFUSED', 'PAYMENT_REFUSED', 'Captura do cartão recusada.', { blockDelivery: true }),
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: paymentTransition('REFUSED', 'PAYMENT_RISK_REFUSED', 'Pagamento reprovado na análise de risco.', { blockDelivery: true }),
  PAYMENT_CREDIT_CARD_THREE_D_SECURE_CHALLENGE_FAILED: paymentTransition('REFUSED', 'THREE_DS_CHALLENGE_FAILED', 'Autenticação 3DS falhou ou foi abandonada.', { blockDelivery: true }),
  PAYMENT_DELETED: paymentTransition('CANCELED', 'PAYMENT_CANCELED', 'Cobrança excluída no provedor.', { blockDelivery: true }),
  PAYMENT_REFUND_IN_PROGRESS: paymentTransition('CANCELED', 'PAYMENT_REFUND_IN_PROGRESS', 'Estorno em processamento.', { blockDelivery: true }),
  PAYMENT_REFUNDED: paymentTransition('CANCELED', 'PAYMENT_REFUNDED', 'Pagamento estornado.', { blockDelivery: true }),
  PAYMENT_PARTIALLY_REFUNDED: paymentTransition('CANCELED', 'PAYMENT_PARTIALLY_REFUNDED', 'Pagamento estornado parcialmente.', { blockDelivery: true }),
  PAYMENT_CHARGEBACK_REQUESTED: paymentTransition('CANCELED', 'PAYMENT_CHARGEBACK_REQUESTED', 'Chargeback recebido.', { blockDelivery: true })
});

function createDelivery() {
  const hexCode = randomBytes(8).toString('hex').toUpperCase();
  return {
    id: randomUUID(),
    code: hexCode.match(/.{4}/g).join('-')
  };
}

async function processAsaasWebhook(body) {
  const event = {
    id: body.id,
    type: body.event,
    checkoutId: safeTechnicalId(body.checkout?.id, 100),
    checkoutStatus: safeTechnicalId(body.checkout?.status, 40),
    paymentId: safeTechnicalId(body.payment?.id, 100),
    paymentStatus: safeTechnicalId(body.payment?.status, 40),
    billingType: safeTechnicalId(body.payment?.billingType, 40),
    // Horário do evento é auditoria; a documentação não define timezone. Não ordena transições financeiras.
    providerCreatedAt: typeof body.dateCreated === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(body.dateCreated)
      ? body.dateCreated : null
  };
  return orderRepository.receiveAsaasWebhook(event);
}

function safeTechnicalId(value, max) {
  return typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9_&-]+$/.test(value)
    ? value : null;
}

async function processPendingWebhooks() {
  const pending = await orderRepository.listPendingWebhooks();
  for (const event of pending) {
    try {
      const result = await orderRepository.processAsaasWebhook(
        event, Object.hasOwn(CHECKOUT_TRANSITIONS, event.type) ? CHECKOUT_TRANSITIONS[event.type]
          : Object.hasOwn(PAYMENT_TRANSITIONS, event.type) ? PAYMENT_TRANSITIONS[event.type] : null, createDelivery
      );
      console.info('[Webhook Asaas]', JSON.stringify({
        eventId: event.id, eventType: event.type, paymentId: event.paymentId,
        checkoutId: event.checkoutId, orderPublicId: result.orderPublicId, result: result.result
      }));
    } catch (error) {
      await orderRepository.deferWebhook(event.id);
      console.error('[Webhook Asaas]', JSON.stringify({
        eventId: event.id, eventType: event.type, result: 'RETRY',
        code: error.code || 'PROCESSING_ERROR'
      }));
    }
  }
}

// A fila durável é o PostgreSQL. Reiniciar o Node retoma eventos RECEIVED.
function startWebhookWorker() {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try { await processPendingWebhooks(); }
    catch { console.error('[Webhook Asaas] Worker indisponível; nova tentativa automática.'); }
    finally { running = false; }
  }
  const timer = setInterval(tick, 2000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

module.exports = { PAYMENT_TRANSITIONS, CHECKOUT_TRANSITIONS, processAsaasWebhook, processPendingWebhooks, startWebhookWorker };
