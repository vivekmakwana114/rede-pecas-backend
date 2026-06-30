import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '../../.env') });

const requiredEnvVars = [
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'JWT_SECRET'
];

// Simple validation
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Config validation error: environment variable ${envVar} is missing.`);
  }
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  db: {
    url: process.env.DATABASE_URL
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpirationMinutes: parseInt(process.env.JWT_ACCESS_EXPIRATION_MINUTES || '60', 10)
  },
  admin: {
    password: process.env.ADMIN_PASSWORD || 'redepecas2025',
    telefoneFuncionario: process.env.TELEFONE_FUNCIONARIO_REDE_PECAS || ''
  }
};
