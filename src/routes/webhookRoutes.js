const express = require('express');
const webhookController = require('../controllers/webhookController');
const { requireAsaasWebhookToken } = require('../middleware/asaasWebhookAuth');

const router = express.Router();

router.post('/', requireAsaasWebhookToken, webhookController.receive);

module.exports = router;
