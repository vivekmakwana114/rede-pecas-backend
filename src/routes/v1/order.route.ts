import express from 'express';
import {
  getOrders,
  reviewOrderHandler,
  confirmOrderStockHandler,
  getPaymentProofHandler,
} from '../../controllers/order.controller.js';
import { authMiddleware } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { adminValidation } from '../../validations/index.js';

const router = express.Router();

router.get('/orders', authMiddleware, getOrders);
router.post('/orders/:number/review', authMiddleware, validate(adminValidation.orderReview), reviewOrderHandler);
router.post('/orders/:number/confirm/stock', authMiddleware, validate(adminValidation.orderStockConfirmation), confirmOrderStockHandler);
router.get('/orders/:number/payment/proof', authMiddleware, validate(adminValidation.orderNumberParams), getPaymentProofHandler);

export default router;
