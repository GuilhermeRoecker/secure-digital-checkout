const express = require('express');
const orderController = require('../controllers/orderController');

const router = express.Router();

router.get('/', orderController.listAdminOrders);
router.get('/:publicId', orderController.getAdminOrder);

module.exports = router;
