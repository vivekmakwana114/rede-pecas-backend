import express from 'express';
import { getOrders, approveOrderHandler, rejectOrderHandler } from '../../controllers/order.controller.js';
import { authMiddleware } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { adminValidation } from '../../validations/index.js';

const router = express.Router();

router.get('/orders', authMiddleware, getOrders);
router.post('/orders/:number/approve', authMiddleware, validate(adminValidation.orderParams), approveOrderHandler);
router.post('/orders/:number/reject', authMiddleware, validate(adminValidation.orderParams), rejectOrderHandler);

export default router;
