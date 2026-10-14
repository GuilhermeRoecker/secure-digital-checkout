const { randomUUID } = require('node:crypto');
const pool = require('../config/database');

async function withTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createOrder(order) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO orders (
        public_id, customer_name, customer_email, customer_document,
        customer_phone, product_name, amount, status, payment_flow
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATED', $8)
      ON CONFLICT (public_id) DO NOTHING
      RETURNING id, public_id, product_name, amount, status, created_at`,
      [
        order.publicId,
        order.customer.name,
        order.customer.email,
        order.customer.cpfCnpj,
        order.customer.phone,
        order.productName,
        order.amount,
        order.paymentFlow || 'HOSTED_CHECKOUT'
      ]
    );
    const createdOrder = result.rows[0];
    if (!createdOrder) return null;

    await client.query(
      'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
      [createdOrder.id, 'ORDER_CREATED', 'Pedido registrado.']
    );
    await client.query(
      `INSERT INTO digital_deliveries (id, order_id, product_type, status)
       VALUES ($1, $2, 'GIFT_CARD', 'BLOCKED')`,
      [randomUUID(), createdOrder.id]
    );

    return createdOrder;
  });
}

async function addEvent(publicId, eventType, description) {
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, description)
     SELECT id, $2, $3 FROM orders WHERE public_id = $1`,
    [publicId, eventType, description]
  );
}

async function markCheckoutCreated(publicId, checkout) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
       SET status = 'CHECKOUT_CREATED', asaas_checkout_id = $2,
           asaas_checkout_url = $3, failure_code = NULL, failure_message = NULL,
           updated_at = NOW()
       WHERE public_id = $1
       RETURNING id, public_id, product_name, amount, status, created_at,
                 asaas_checkout_id, asaas_checkout_url`,
      [publicId, checkout.id, checkout.link]
    );
    const order = result.rows[0];

    if (!order) {
      throw new Error('Pedido não encontrado ao salvar o checkout.');
    }

    await client.query(
      'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
      [order.id, 'CHECKOUT_CREATED', 'Checkout criado no Asaas Sandbox.']
    );

    return order;
  });
}

async function markCheckoutError(publicId, failureCode, failureMessage) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
       SET status = 'CHECKOUT_ERROR', failure_code = $2,
           failure_message = $3, updated_at = NOW()
       WHERE public_id = $1
       RETURNING id, public_id, product_name, amount, status, created_at`,
      [publicId, failureCode, failureMessage]
    );
    const order = result.rows[0];

    if (!order) {
      throw new Error('Pedido não encontrado ao registrar falha do checkout.');
    }

    await client.query(
      'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
      [order.id, 'CHECKOUT_ERROR', `Checkout não criado (${failureCode}).`]
    );

    return order;
  });
}

async function recordDirectResult(publicId, { paymentId = null, customerId = null, challenge = false, failure = null } = {}) {
  return withTransaction(async (client) => {
    const selected = await client.query(
      "SELECT id, status FROM orders WHERE public_id=$1 AND payment_flow='DIRECT_3DS' FOR UPDATE", [publicId]
    );
    const order = selected.rows[0];
    if (!order) throw new Error('Pedido direto não encontrado.');
    await client.query(
      `UPDATE orders SET asaas_payment_id=COALESCE($2, asaas_payment_id),
        asaas_customer_id=COALESCE($3, asaas_customer_id),
        status=CASE WHEN status='CREATED' THEN $4 ELSE status END, updated_at=NOW()
       WHERE id=$1`,
      [order.id, paymentId, customerId, failure ? (failure === 'PAYMENT_REJECTED_OR_INVALID' ? 'REFUSED' : 'UNDER_REVIEW') : 'PENDING']
    );
    for (const [type, description] of failure
      ? [[failure, 'Tentativa direta não concluída; consulte o acompanhamento antes de tentar novamente.']]
      : [['THREE_DS_REQUESTED', '3DS enviado ao Asaas Sandbox; aguardando confirmação por webhook.'],
        [challenge ? 'THREE_DS_CHALLENGE_REQUIRED' : 'PAYMENT_SUBMITTED',
          challenge ? 'Asaas retornou desafio do emissor.' : 'Cobrança enviada; entrega depende do webhook.']]) {
      await client.query('INSERT INTO order_events (order_id,event_type,description) VALUES ($1,$2,$3)', [order.id, type, description]);
    }
  });
}

async function receiveAsaasWebhook(event) {
  const result = await pool.query(
    `INSERT INTO webhook_events (
      provider, provider_event_id, event_type, checkout_id, checkout_status, payment_id, payment_status, billing_type, provider_created_at
    ) VALUES ('ASAAS', $1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
    [event.id, event.type, event.checkoutId, event.checkoutStatus, event.paymentId,
      event.paymentStatus, event.billingType, event.providerCreatedAt]
  );
  console.info('[Webhook Asaas]', JSON.stringify({
    eventId: event.id, eventType: event.type, paymentId: event.paymentId,
    result: result.rowCount ? 'RECEIVED' : 'DUPLICATE'
  }));
  return { result: result.rowCount ? 'RECEIVED' : 'DUPLICATE' };
}

async function listPendingWebhooks() {
  const result = await pool.query(
    `SELECT provider_event_id AS id, event_type AS type, checkout_id AS "checkoutId",
            checkout_status AS "checkoutStatus", payment_id AS "paymentId",
            payment_status AS "paymentStatus", billing_type AS "billingType",
            provider_created_at AS "providerCreatedAt"
     FROM webhook_events WHERE provider = 'ASAAS' AND status = 'RECEIVED'
       AND next_attempt_at <= NOW() ORDER BY id LIMIT 20`
  );
  return result.rows;
}

async function deferWebhook(eventId) {
  await pool.query(
    `UPDATE webhook_events SET next_attempt_at = NOW() + INTERVAL '30 seconds'
     WHERE provider = 'ASAAS' AND provider_event_id = $1 AND status = 'RECEIVED'`, [eventId]
  );
}

async function processAsaasWebhook(event, transition, createDelivery) {
  return withTransaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const insertedEvent = await client.query(
      `SELECT id FROM webhook_events
       WHERE provider = 'ASAAS' AND provider_event_id = $1 AND status = 'RECEIVED'
       FOR UPDATE SKIP LOCKED`, [event.id]
    );
    if (!insertedEvent.rowCount) return { result: 'DUPLICATE', orderPublicId: null };

    const webhookEventId = insertedEvent.rows[0].id;
    const isPayment = transition?.resource === 'payment';
    if (!transition
      || (isPayment ? !event.paymentId || (transition.paymentStatus && event.paymentStatus !== transition.paymentStatus)
        || (event.billingType && event.billingType !== 'CREDIT_CARD')
        : !event.checkoutId || event.checkoutStatus !== transition.checkoutStatus)) {
      await client.query(
        `UPDATE webhook_events SET status = 'IGNORED', processed_at = NOW() WHERE id = $1`,
        [webhookEventId]
      );
      return { result: 'IGNORED', orderPublicId: null };
    }

    const orderResult = await client.query(
      `SELECT id, public_id, status
       FROM orders
       WHERE ((asaas_checkout_id = $1 AND payment_flow = 'HOSTED_CHECKOUT')
         OR (asaas_payment_id = $2 AND payment_flow = 'DIRECT_3DS'))
       FOR UPDATE`,
      [isPayment ? null : event.checkoutId, isPayment ? event.paymentId : null]
    );
    const order = orderResult.rows[0];

    if (orderResult.rowCount !== 1) {
      const error = new Error('Checkout sem associação única a um pedido local.');
      error.statusCode = 503;
      throw error;
    }

    await client.query(
      'UPDATE webhook_events SET order_id = $2 WHERE id = $1',
      [webhookEventId, order.id]
    );

    // No fluxo direto, bloqueios financeiros são terminais: confirmação tardia não reabre entrega.
    const directBlocked = isPayment && ['REFUSED', 'CANCELED', 'EXPIRED'].includes(order.status);
    if (transition.orderStatus === 'CONFIRMED' && !directBlocked) {
      if (order.status !== 'CONFIRMED') {
        await client.query(
          `UPDATE orders SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1`,
          [order.id]
        );
        await client.query(
          'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
          [order.id, 'PAYMENT_CONFIRMED', `Pagamento confirmado pelo evento ${event.type} do Asaas.`]
        );
      }

      const deliveryResult = await client.query(
        'SELECT id, status FROM digital_deliveries WHERE order_id = $1 FOR UPDATE',
        [order.id]
      );
      const delivery = deliveryResult.rows[0];

      if (!delivery || delivery.status === 'BLOCKED') {
        const generated = createDelivery();
        if (delivery) {
          await client.query(
            `UPDATE digital_deliveries
             SET delivery_code = $2, status = 'RELEASED', released_at = NOW()
             WHERE id = $1`,
            [delivery.id, generated.code]
          );
        } else {
          await client.query(
            `INSERT INTO digital_deliveries (
              id, order_id, product_type, delivery_code, status, released_at
            ) VALUES ($1, $2, 'GIFT_CARD', $3, 'RELEASED', NOW())`,
            [generated.id, order.id, generated.code]
          );
        }
        await client.query(
          'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
          [order.id, 'DELIVERY_RELEASED', 'Gift Card liberado após confirmação do Asaas.']
        );
      }
    } else if (isPayment) {
      const blocking = transition.blockDelivery;
      const ranks = { CREATED: 0, PENDING: 1, UNDER_REVIEW: 2, CONFIRMED: 3, REFUSED: 4, CANCELED: 5, EXPIRED: 5 };
      if (blocking || (!directBlocked && (ranks[transition.orderStatus] >= (ranks[order.status] ?? 0)))) {
        if (ranks[transition.orderStatus] > (ranks[order.status] ?? 0)) {
          await client.query('UPDATE orders SET status=$2, updated_at=NOW() WHERE id=$1', [order.id, transition.orderStatus]);
        }
        await client.query(
          `INSERT INTO order_events (order_id, event_type, description)
           SELECT $1::bigint, $2::varchar, $3::varchar WHERE NOT EXISTS (
             SELECT 1 FROM order_events WHERE order_id=$1 AND event_type=$2)`,
          [order.id, transition.orderEventType, transition.orderEventDescription]
        );
        if (blocking) {
          await client.query("UPDATE digital_deliveries SET status='BLOCKED' WHERE order_id=$1", [order.id]);
          await client.query(
            `INSERT INTO order_events (order_id, event_type, description)
             SELECT $1::bigint, 'DELIVERY_BLOCKED', 'Entrega bloqueada por evento financeiro do Asaas.'
             WHERE NOT EXISTS (SELECT 1 FROM order_events WHERE order_id=$1 AND event_type='DELIVERY_BLOCKED')`, [order.id]
          );
        }
      }
    } else if (order.status !== transition.orderStatus
      && !['CONFIRMED', 'REFUSED', 'CANCELED', 'EXPIRED'].includes(order.status)) {
      await client.query(
        'UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1',
        [order.id, transition.orderStatus]
      );
      await client.query(
        'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
        [order.id, transition.orderEventType, transition.orderEventDescription]
      );
    }

    if (!isPayment && ['CANCELED', 'EXPIRED'].includes(transition.orderStatus)
      && !['CONFIRMED', 'REFUSED', 'CANCELED', 'EXPIRED'].includes(order.status)) {
      await client.query(
        'INSERT INTO order_events (order_id, event_type, description) VALUES ($1, $2, $3)',
        [order.id, 'DELIVERY_BLOCKED', 'Entrega permanece bloqueada: checkout encerrado sem confirmação.']
      );
    }

    await client.query(
      `UPDATE webhook_events SET status = 'PROCESSED', processed_at = NOW() WHERE id = $1`,
      [webhookEventId]
    );

    return { result: 'PROCESSED', orderPublicId: order.public_id };
  });
}

async function listOrders() {
  const result = await pool.query(
    `SELECT orders.public_id, 'Oculto' AS customer_name, orders.product_name,
            orders.amount, orders.status, orders.payment_flow, orders.asaas_payment_id, orders.asaas_checkout_id,
            orders.asaas_checkout_url, digital_deliveries.status AS delivery_status,
            orders.created_at
     FROM orders
     LEFT JOIN digital_deliveries ON digital_deliveries.order_id = orders.id
     ORDER BY orders.created_at DESC LIMIT 200`
  );

  return result.rows;
}

async function findOrderByPublicId(publicId, { includeDeliveryCode = false } = {}) {
  const result = await pool.query(
    `SELECT orders.id, orders.public_id, 'Oculto' AS customer_name,
            orders.product_name, orders.amount, orders.status, orders.payment_flow, orders.asaas_payment_id,
            orders.asaas_checkout_id, orders.asaas_checkout_url,
            orders.failure_code, orders.failure_message, orders.created_at,
            orders.updated_at, digital_deliveries.status AS delivery_status,
            CASE WHEN $2::boolean AND orders.status = 'CONFIRMED'
                       AND digital_deliveries.status = 'RELEASED'
                 THEN digital_deliveries.delivery_code
                 ELSE NULL END AS delivery_code
     FROM orders
     LEFT JOIN digital_deliveries ON digital_deliveries.order_id = orders.id
     WHERE orders.public_id = $1`,
    [publicId, includeDeliveryCode]
  );

  return result.rows[0] || null;
}

async function listEvents(publicId) {
  const result = await pool.query(
    `SELECT order_events.event_type, order_events.description, order_events.created_at
     FROM order_events
     INNER JOIN orders ON orders.id = order_events.order_id
     WHERE orders.public_id = $1
     ORDER BY order_events.created_at ASC, order_events.id ASC`,
    [publicId]
  );

  return result.rows;
}

module.exports = {
  recordDirectResult,
  receiveAsaasWebhook,
  listPendingWebhooks,
  deferWebhook,
  addEvent,
  createOrder,
  findOrderByPublicId,
  listEvents,
  listOrders,
  markCheckoutCreated,
  markCheckoutError,
  processAsaasWebhook
};
