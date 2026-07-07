import express from 'express';
import whatsappRoute from './whatsapp.route.js';
import authRoute from './auth.route.js';
import orderRoute from './order.route.js';
import productRoute from './product.route.js';

const router = express.Router();

const defaultRoutes = [
  { path: '/webhook/whatsapp', route: whatsappRoute },
  { path: '/admin', route: authRoute },
  { path: '/admin', route: orderRoute },
  { path: '/admin', route: productRoute },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
