import express from 'express';
import multer from 'multer';
import { importProductsBatchHandler, importProductsFileHandler } from '../../controllers/product.controller.js';
import { authMiddleware } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { adminValidation } from '../../validations/index.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/inventory/upload', authMiddleware, validate(adminValidation.importProductsBatch), importProductsBatchHandler);
router.post(
  '/inventory/import',
  authMiddleware,
  upload.single('file'),
  validate(adminValidation.importProductsFile),
  importProductsFileHandler
);

export default router;
