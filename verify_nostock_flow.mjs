import { db } from './src/config/db.ts';
import { getPendingWaitlistOffer } from './src/services/session.service.ts';

const TEST_PHONE = '244000000058';

async function main() {
  await db.query(`INSERT INTO customers (phone, name, registration_status, registered_at) VALUES ($1, 'Test', 'complete', NOW()) ON CONFLICT (phone) DO NOTHING`, [TEST_PHONE]);
  const supplierRow = await db.query('SELECT id FROM suppliers LIMIT 1');
  const supplierId = supplierRow.rows[0].id;
  await db.query(`DELETE FROM products WHERE reference = 'NOSTOCK-TEST'`);
  const productInsert = await db.query(
    `INSERT INTO products (supplier_id, name, reference, price, quantity, delivery_time)
     VALUES ($1, 'Nostock Test Filter', 'NOSTOCK-TEST', 5000, 0, 'Tomorrow') RETURNING id`,
    [supplierId]
  );
  const productId = productInsert.rows[0].id;

  const { searchAndRespond } = await import('./src/services/product.service.ts');
  try {
    await searchAndRespond(TEST_PHONE, 'Nostock Test Filter', 'Test');
  } catch (e) {
    console.log('(expected) WhatsApp send failed against fake test number:', e.message);
  }

  const offer = await getPendingWaitlistOffer(TEST_PHONE);
  console.log('pendingWaitlistOffer state (may be null if the buttons-send failed before saving, same known precedent):', offer);

  await db.query(`DELETE FROM products WHERE id = $1`, [productId]);
  await db.query(`DELETE FROM customers WHERE phone = $1`, [TEST_PHONE]);
  console.log('Cleanup done.');
  await db.end();
}
main().catch(async e => { console.error('FATAL', e); await db.end(); process.exit(1); });
