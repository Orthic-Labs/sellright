import { eq } from 'drizzle-orm';
import { pool, withStore } from '../db/client.js';
import * as s from '../db/schema.js';
import { hashPassword } from '../auth/password.js';

const connection = new URL(process.env.DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(connection.protocol) ||
    connection.pathname !== '/sellright_demo' || process.env.SELLRIGHT_DEMO_SEED !== '1') {
  throw new Error('Demo seeding requires SELLRIGHT_DEMO_SEED=1 and database sellright_demo');
}
const password = process.env.DEMO_ADMIN_PASSWORD;
if (!password || password.length < 16) throw new Error('Set a dedicated DEMO_ADMIN_PASSWORD of at least 16 characters');
const apply = process.argv.includes('--apply');
const storeId = 'de000000-0000-4000-8000-000000000001';
const email = 'visitor@demo.example';
const products = [
  { name: 'Studio Notebook', slug: 'studio-notebook', sku: 'DEMO-NOTEBOOK', price: 1800, type: 'Stationery', color: 'sage' },
  { name: 'Everyday Tote', slug: 'everyday-tote', sku: 'DEMO-TOTE', price: 2400, type: 'Carry', color: 'coral' },
  { name: 'Stoneware Cup', slug: 'stoneware-cup', sku: 'DEMO-CUP', price: 2200, type: 'Home', color: 'blue' },
  { name: 'Desk Tray', slug: 'desk-tray', sku: 'DEMO-TRAY', price: 3200, type: 'Home', color: 'rose' },
];

try {
  const { rows } = await pool.query('SELECT id, config FROM store');
  if (rows.length) {
    if (rows.length !== 1 || rows[0].id !== storeId || rows[0].config?.demo !== true) {
      throw new Error('Refusing to seed a database containing non-demo stores');
    }
    console.log('Demo already seeded; existing rows and credentials left unchanged');
  } else {
    const passwordHash = await hashPassword(password);
    const rollback = new Error('demo dry-run rollback');
    try {
      await withStore(storeId, async (tx) => {
        await tx.insert(s.store).values({
          id: storeId, slug: 'demo', name: 'SellRight Demo', currency: 'USD',
          config: {
            demo: true, hostnames: ['demo.sellright.cc', 'localhost', '127.0.0.1'],
            storefrontUrl: 'https://demo.sellright.cc',
            payments: { stripe: false, nmi: false, sezzle: false, cod: false, manual: false },
          },
        });
        const [visitor] = await tx.insert(s.adminUser).values({ email, passwordHash }).returning();
        await tx.insert(s.adminUserStore).values({ adminUserId: visitor!.id, storeId, role: 'read_only' });
        for (const [i, item] of products.entries()) {
          const [product] = await tx.insert(s.product).values({
            storeId, name: item.name, slug: item.slug, status: 'active', productType: item.type,
            description: 'Synthetic demonstration product. Not available for purchase or shipment.',
            tags: ['demo', item.type.toLowerCase()], metafields: { demoColor: item.color },
          }).returning();
          const [variant] = await tx.insert(s.productVariant).values({
            storeId, productId: product!.id, sku: item.sku, name: item.name, price: item.price,
            fulfillmentType: 'physical', weightG: 200,
          }).returning();
          await tx.insert(s.stock).values({ storeId, variantId: variant!.id, onHand: 20 + i * 8 });
          const [order] = await tx.insert(s.order).values({
            storeId, code: 'DEMO-' + (1001 + i), state: i === 3 ? 'PendingPayment' : 'Paid',
            currency: 'USD', subtotal: item.price, grandTotal: item.price,
            placedAt: new Date(), metadata: { syntheticDemo: true },
          }).returning();
          await tx.insert(s.orderLine).values({
            storeId, orderId: order!.id, variantId: variant!.id, variantSku: item.sku,
            variantName: item.name, quantity: 1, unitPrice: item.price,
            lineSubtotal: item.price, lineTotal: item.price,
          });
        }
        const seeded = await tx.select({ id: s.product.id }).from(s.product).where(eq(s.product.storeId, storeId));
        console.log(JSON.stringify({ database: 'sellright_demo', products: seeded.length, orders: 4, adminRole: 'read_only', apply }));
        if (!apply) throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
      console.log('Dry run rolled back; no demo rows retained');
    }
  }
} finally {
  await pool.end();
}
