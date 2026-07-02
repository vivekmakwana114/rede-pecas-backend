import express from 'express';
import {
  login,
  getOrders,
  approveOrderHandler,
  rejectOrderHandler,
  importPartsBatchHandler
} from '../../controllers/admin.controller.js';
import { authMiddleware } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { adminValidation } from '../../validations/index.js';

const router = express.Router();

// Public auth endpoint
router.post('/login', validate(adminValidation.login), login);

// Protected endpoints
router.get('/orders', authMiddleware, getOrders);
router.post('/orders/:number/approve', authMiddleware, validate(adminValidation.orderParams), approveOrderHandler);
router.post('/orders/:number/reject', authMiddleware, validate(adminValidation.orderParams), rejectOrderHandler);
router.post('/inventory/upload', authMiddleware, validate(adminValidation.importPartsBatch), importPartsBatchHandler);

export default router;
