import app from './app.js';
import { config } from './config/config.js';
import { logger } from './config/logger.js';
import { sendStockConfirmationCourtesyMessages, sendStockConfirmationAdminReminders } from './services/product.service.js';

const server = app.listen(config.port, () => {
  logger.info(`Rede Peças central backend listening on port ${config.port} in ${config.env} mode`);
});

// No job-queue infra in this repo — a simple polling sweep for the one proactive
// outbound message this app needs to fire without any incoming trigger (the
// 20-minute "still confirming with the supplier" courtesy message). Idempotent
// per order via stock_confirmation_courtesy_sent, so overlapping ticks are safe.
const courtesySweepInterval = setInterval(() => {
  sendStockConfirmationCourtesyMessages().catch((error) => {
    logger.error('Error running stock-confirmation courtesy message sweep', error);
  });
}, 60_000);

// Same reasoning as the courtesy sweep above, for the 15-minute admin SLA
// reminder instead of the customer's 20-minute courtesy message.
const adminReminderSweepInterval = setInterval(() => {
  sendStockConfirmationAdminReminders().catch((error) => {
    logger.error('Error running stock-confirmation admin reminder sweep', error);
  });
}, 60_000);

const exitHandler = () => {
  clearInterval(courtesySweepInterval);
  clearInterval(adminReminderSweepInterval);
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

const unexpectedErrorHandler = (error: any) => {
  logger.error('Unexpected runtime exception', error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  if (server) {
    server.close();
  }
});
