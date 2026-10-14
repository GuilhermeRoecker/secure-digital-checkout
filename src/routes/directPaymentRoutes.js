const express = require('express');
const { requireDirectHttps, createDirectPaymentLimiter } = require('../middleware/directPaymentSecurity');
const controller = require('../controllers/directPaymentController');
const router = express.Router();
router.post('/', requireDirectHttps, createDirectPaymentLimiter(), express.json({ limit: '8kb' }), controller.create);
// O parser JSON pode conter trechos do cartão em error.message. Nunca propagar esse erro.
router.use((error, req, res, next) => {
  req.body = undefined;
  res.status(error.type === 'entity.too.large' ? 413 : 400).json({ success: false,
    error: { type: 'INVALID_PAYMENT_REQUEST', message: 'Requisição de pagamento inválida.' } });
});
module.exports = router;
