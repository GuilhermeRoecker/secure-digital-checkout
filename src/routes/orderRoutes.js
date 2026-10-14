const express = require('express');
const orderController = require('../controllers/orderController');

const router = express.Router();

router.get('/:publicId', orderController.getStatus);

module.exports = router;
