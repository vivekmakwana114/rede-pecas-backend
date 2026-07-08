// Wipes all data from the database in DATABASE_URL (structure stays intact —
// use db:migrate afterwards only if you also need to reapply schema changes).
// admin_users is preserved by default so you don't get locked out of the
// admin panel; pass --all to wipe it too.
//
// Usage:
//   node db/clear.js            (asks for confirmation)
//   node db/clear.js --yes      (skips confirmation)
//   node db/clear.js --all      (also truncates admin_users)
//  npm run db:clear
// npm run db:clear -- --yes
//  npm run db:clear -- --all
import { createInterface } from 'readline/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Create a .env file (see .env.example).');
  process.exit(1);
}

const includeAdmins = process.argv.includes('--all');
const skipConfirm = process.argv.includes('--yes') || process.argv.includes('-y');

const TABLES = [
  'orders',
  'vehicles',
  'nhtsa_vehicles',
  'sync_logs',
  'order_counters',
  'products',
  'suppliers',
  'customers',
  ...(includeAdmins ? ['admin_users'] : []),
];

if (!skipConfirm) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const target = process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@');
  console.log(`This will TRUNCATE these tables on ${target}:`);
  console.log('  ' + TABLES.join(', '));
  if (!includeAdmins) console.log('  (admin_users is kept — pass --all to wipe it too)');
  const answer = await rl.question('Type "yes" to continue: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  console.log(`Cleared: ${TABLES.join(', ')}`);
} catch (err) {
  console.error('Clear failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
