const orderRepository = require('../repositories/orderRepository');

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function notFound(res) {
  return res.status(404).json({
    success: false,
    error: { type: 'ORDER_NOT_FOUND', message: 'Pedido não encontrado.' }
  });
}

async function getStatus(req, res, next) {
  if (!isUuid(req.params.publicId)) return notFound(res);

  try {
    const order = await orderRepository.findOrderByPublicId(req.params.publicId, {
      includeDeliveryCode: true
    });
    if (!order) return notFound(res);

    const events = await orderRepository.listEvents(order.public_id);
    const deliveryReleased = order.status === 'CONFIRMED'
      && order.delivery_status === 'RELEASED';
    const paymentStatus = {
      CONFIRMED: 'Confirmado',
      REFUSED: 'Recusado',
      CANCELED: 'Cancelado',
      EXPIRED: 'Expirado',
      UNDER_REVIEW: 'Em análise',
      CHECKOUT_ERROR: 'Não iniciado'
    }[order.status] || 'Aguardando confirmação';

    return res.json({
      success: true,
      order: {
        publicId: order.public_id,
        number: order.public_id.slice(0, 8).toUpperCase(),
        productName: order.product_name,
        amount: Number(order.amount),
        status: order.status,
        createdAt: order.created_at,
        paymentStatus,
        paymentFlow: order.payment_flow,
        securityStatus: order.payment_flow === 'DIRECT_3DS'
          ? (events.some(e => e.event_type === 'THREE_DS_CHALLENGE_FAILED') ? 'Falha na autenticação 3DS'
            : events.some(e => e.event_type === 'THREE_DS_REQUESTED') ? '3DS solicitado ao Asaas Sandbox' : '3DS ainda não enviado')
          : '3DS não solicitado neste fluxo',
        deliveryStatus: deliveryReleased ? 'Liberada' : 'Bloqueada',
        deliveryCode: deliveryReleased ? order.delivery_code : null
      },
      events
    });
  } catch (error) {
    return next(error);
  }
}

async function listAdminOrders(req, res, next) {
  try {
    const orders = await orderRepository.listOrders();
    return res.json({ success: true, orders });
  } catch (error) {
    return next(error);
  }
}

async function getAdminOrder(req, res, next) {
  if (!isUuid(req.params.publicId)) return notFound(res);

  try {
    const order = await orderRepository.findOrderByPublicId(req.params.publicId);
    if (!order) return notFound(res);

    const events = await orderRepository.listEvents(order.public_id);
    return res.json({ success: true, order, events });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getAdminOrder, getStatus, listAdminOrders };
