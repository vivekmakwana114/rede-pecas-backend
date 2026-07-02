import express from 'express';
import whatsappRoute from './whatsapp.route.js';
import adminRoute from './admin.route.js';

const router = express.Router();

const defaultRoutes = [
  { path: '/webhook/whatsapp', route: whatsappRoute },
  { path: '/admin', route: adminRoute },
];

defaultRoutes.forEach((route) => {
  router.use(route.path, route.route);
});

export default router;
