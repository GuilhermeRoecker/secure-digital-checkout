const express = require('express');
const helmet = require('helmet');
const path = require('node:path');
const checkoutRoutes = require('./routes/checkoutRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminOrderRoutes = require('./routes/adminOrderRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

app.use(helmet());
app.use('/api/webhooks/asaas', express.json({ limit: '64kb' }), webhookRoutes);
app.use('/api/payments/direct', require('./routes/directPaymentRoutes'));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/checkout', checkoutRoutes);
app.use('/api/orders', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, orderRoutes);
app.use('/api/admin/orders', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, adminOrderRoutes);

app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/order/:publicId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.get('/payments/direct', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'direct-payment.html'));
});

app.get('/payments/3ds/callback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'checkout-result.html'));
});

app.get('/checkout/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout-result.html'));
});

app.get('/checkout/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout-result.html'));
});

app.use((req, res, next) => {
  const error = new Error('Rota não encontrada.');
  error.statusCode = 404;
  next(error);
});

app.use((error, req, res, next) => {
  const candidate = error.statusCode || error.status;
  const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const message = statusCode < 500
    ? error.message
    : 'Não foi possível concluir a solicitação.';

  if (statusCode >= 500) {
    console.error('[Aplicação] Erro interno', error.code || error.name || 'UNKNOWN');
  }

  res.status(statusCode).json({
    success: false,
    error: {
      type: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR',
      message
    }
  });
});

module.exports = app;
