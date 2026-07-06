import express from 'express';
import { verifyWebhook, receiveWebhookMessage } from '../controllers/whatsapp.controller.js';

const router = express.Router();

router.get('/', verifyWebhook);
router.post('/', receiveWebhookMessage);

export default router;
