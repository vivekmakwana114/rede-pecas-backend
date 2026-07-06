import express from 'express';
import whatsappRoute from './whatsapp.route.js';
import adminRoute from './admin.route.js';

const router = express.Router();

router.use('/v1/webhook/whatsapp', whatsappRoute);
router.use('/v1/admin', adminRoute);

export default router;
