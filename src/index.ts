import app from './app.js';
import { config } from './config/config.js';
import { logger } from './config/logger.js';
import { sendStockConfirmationCourtesyMessages, sendStockConfirmationAdminReminders } from './services/product.service.js';

const server = app.listen(config.port, () => {
  logger.info(`Rede Peças central backend listening on port ${config.port} in ${config.env} mode`);
});

const courtesySweepInterval = setInterval(() => {
  sendStockConfirmationCourtesyMessages().catch((error) => {
    logger.error('Error running stock-confirmation courtesy message sweep', error);
  });
}, 60_000);

const adminReminderSweepInterval = setInterval(() => {
  sendStockConfirmationAdminReminders().catch((error) => {
    logger.error('Error running stock-confirmation admin reminder sweep', error);
  });
}, 60_000);

/**
 * Gracefully shuts the server down: stops the background sweep intervals,
 * closes the HTTP server, and exits the process.
 */
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

/**
 * Logs an unhandled exception or rejection and triggers the same graceful
 * shutdown path as a normal exit.
 */
const unexpectedErrorHandler = (error: any) => {
  logger.error('Unexpected runtime exception', error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  exitHandler();
});
