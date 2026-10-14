const ordersBody = document.querySelector('#orders-body');
const ordersMessage = document.querySelector('#orders-message');
const detailPanel = document.querySelector('#admin-order-detail');
const adminTimeline = document.querySelector('#admin-timeline');

function cell(row, value) {
  const element = document.createElement('td');
  element.textContent = value;
  row.append(element);
  return element;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function formatAmount(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value));
}

function paymentLabel(status) {
  return {
    CONFIRMED: 'Confirmado',
    REFUSED: 'Recusado',
    CANCELED: 'Cancelado',
    EXPIRED: 'Expirado',
    UNDER_REVIEW: 'Em análise',
    CHECKOUT_CREATED: 'Aguardando',
    CREATED: 'Aguardando',
    CHECKOUT_ERROR: 'Não iniciado'
  }[status] || 'Aguardando';
}

function renderOrderRow(order) {
  const row = document.createElement('tr');
  const idCell = document.createElement('td');
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'order-select';
  select.textContent = order.public_id.slice(0, 8).toUpperCase();
  select.addEventListener('click', () => loadOrderDetail(order.public_id));
  idCell.append(select);
  row.append(idCell);
  cell(row, order.payment_flow === 'DIRECT_3DS' ? 'Cartão + 3DS' : 'Checkout Asaas');
  cell(row, order.product_name);
  cell(row, formatAmount(order.amount));
  const checkoutCell = document.createElement('td');
  if (order.asaas_checkout_url) {
    const link = document.createElement('a');
    link.href = order.asaas_checkout_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'table-link';
    link.textContent = 'Criado · Abrir ↗';
    checkoutCell.append(link);
  } else {
    checkoutCell.textContent = order.asaas_payment_id ? `Pagamento …${order.asaas_payment_id.slice(-8)}` : 'Não criado';
  }
  row.append(checkoutCell);
  cell(row, paymentLabel(order.status));
  const orderStatusCell = cell(row, order.status.replaceAll('_', ' '));
  orderStatusCell.dataset.status = order.status;
  cell(row, order.delivery_status === 'RELEASED' ? 'Liberada' : 'Bloqueada');
  cell(row, formatDate(order.created_at));
  return row;
}

function appendTimelineEvent(event) {
  const item = document.createElement('li');
  const time = document.createElement('time');
  const content = document.createElement('span');
  time.dateTime = event.created_at;
  time.textContent = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date(event.created_at));
  content.textContent = `${event.event_type} — ${event.description}`;
  if (event.event_type === 'CHECKOUT_ERROR') content.dataset.state = 'error';
  item.append(time, content);
  adminTimeline.append(item);
}

async function loadOrderDetail(publicId) {
  try {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(publicId)}`);
    const result = await readApiJsonResponse(response);
    if (!response.ok) throw new Error(result.error?.message || 'Pedido não encontrado.');

    const { order, events } = result;
    document.querySelector('#detail-order-number').textContent = publicId.slice(0, 8).toUpperCase();
    document.querySelector('#detail-customer').textContent = order.payment_flow === 'DIRECT_3DS' ? 'Cartão + 3DS' : 'Checkout Asaas';
    document.querySelector('#detail-product').textContent = order.product_name;
    document.querySelector('#detail-amount').textContent = formatAmount(order.amount);
    document.querySelector('#detail-status').textContent = order.status.replaceAll('_', ' ');
    document.querySelector('#detail-delivery-status').textContent = order.delivery_status === 'RELEASED' ? 'Liberada' : 'Bloqueada';
    document.querySelector('#detail-status-link').href = `/order/${encodeURIComponent(publicId)}`;
    const checkoutLink = document.querySelector('#detail-checkout-link');
    checkoutLink.hidden = !order.asaas_checkout_url;
    if (order.asaas_checkout_url) checkoutLink.href = order.asaas_checkout_url;
    adminTimeline.replaceChildren();
    events.forEach(appendTimelineEvent);
    detailPanel.hidden = false;
  } catch (error) {
    ordersMessage.textContent = error.message;
  }
}

async function loadOrders() {
  try {
    const response = await fetch('/api/admin/orders');
    const result = await readApiJsonResponse(response);
    if (!response.ok) throw new Error(result.error?.message || 'Não foi possível carregar os pedidos.');

    ordersBody.replaceChildren(...result.orders.map(renderOrderRow));
    ordersMessage.textContent = result.orders.length
      ? `${result.orders.length} pedido(s)`
      : 'Nenhum pedido registrado';
  } catch (error) {
    ordersMessage.textContent = error.message;
    ordersMessage.dataset.state = 'error';
  }
}

loadOrders();
