import winston from 'winston';
import { config } from './config.js';

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    Object.assign(info, { message: info.stack });
  }
  return info;
});

export const logger = winston.createLogger({
  level: config.env === 'development' ? 'debug' : 'info',
  format: winston.format.combine(
    enumerateErrorFormat(),
    config.env === 'development' ? winston.format.colorize() : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(({ level, message, ...meta }) => {
      // logger.error('some message', errorObj) merges errorObj's own keys into info
      // rather than into `message` — without this, the actual error detail (e.g.
      // Meta's OAuthException body) never reached the console, only "[error] some message".
      const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return `[${level}] ${message}${extra}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});
export default logger;
