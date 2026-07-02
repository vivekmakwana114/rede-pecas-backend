import app from './app.js';
import { config } from './config/config.js';
import { logger } from './config/logger.js';

const server = app.listen(config.port, () => {
  logger.info(`Rede Peças central backend listening on port ${config.port} in ${config.env} mode`);
});

const exitHandler = () => {
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
