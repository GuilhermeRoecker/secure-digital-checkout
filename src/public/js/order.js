const loadMessage = document.querySelector('#order-load-message');
const statusView = document.querySelector('#order-status-view');
const orderTimeline = document.querySelector('#order-timeline');
const publicId = window.location.pathname.split('/').filter(Boolean).at(-1);

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function addTimelineEvent(list, event) {
  const item = document.createElement('li');
  const time = document.createElement('time');
  const content = document.createElement('span');
  time.dateTime = event.created_at;
  time.textContent = formatDate(event.created_at);
  content.textContent = event.description;
  item.append(time, content);
  list.append(item);
}

async function loadOrder() {
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(publicId)}`);
    const result = await readApiJsonResponse(response);
    if (!response.ok) throw new Error(result.error?.message || 'Pedido não encontrado.');

    const order = result.order;
    document.querySelector('#status-order-number').textContent = order.number;
    document.querySelector('#status-order-state').textContent = order.status.replaceAll('_', ' ');
    document.querySelector('#status-product').textContent = order.productName;
    document.querySelector('#status-amount').textContent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(order.amount);
    document.querySelector('#status-created').textContent = formatDate(order.createdAt);
    document.querySelector('#payment-status').textContent = order.paymentStatus;
    document.querySelector('#security-status').textContent = order.securityStatus;
    document.querySelector('#security-description').textContent = order.paymentFlow === 'DIRECT_3DS'
      ? 'Sandbox aprova 3DS automaticamente. O resultado financeiro depende do webhook.'
      : 'Pagamento no Checkout hospedado do Asaas.';
    document.querySelector('#delivery-status').textContent = order.deliveryStatus;
    document.querySelector('#delivery-code-panel').hidden = true;
    document.querySelector('#delivery-code').textContent = '';
    if (order.status === 'CONFIRMED' && order.deliveryStatus === 'Liberada' && order.deliveryCode) {
      document.querySelector('#delivery-code').textContent = order.deliveryCode;
      document.querySelector('#delivery-code-panel').hidden = false;
    }
    orderTimeline.replaceChildren();
    result.events.forEach((event) => addTimelineEvent(orderTimeline, event));
    loadMessage.hidden = true;
    statusView.hidden = false;
    document.querySelector('#payment-description').textContent = order.status === 'CONFIRMED'
      ? 'Pagamento confirmado pelo webhook autenticado do Asaas.'
      : 'A entrega depende da confirmação financeira pelo Asaas.';
  } catch (error) {
    loadMessage.textContent = error.message;
    loadMessage.dataset.state = 'error';
  }
}

loadOrder();

setInterval(() => { if (!document.hidden) loadOrder(); }, 5000);
