import { hash } from 'bcryptjs';
import { Database } from './database';
// Called only by the local development launcher, never by production startup.
export async function seed(db: Database) {
  if (await db.users.exists({ email: 'ada@example.com' })) return;
  const passwordHash = await hash('Northstar123!', 12);
  await db.connection.transaction(async session => {
    const [user] = await db.users.create([{ name: 'Ada Okafor', email: 'ada@example.com', passwordHash, role: 'customer' }], { session });
    const ownerId = String(user._id);
    const [everyday, savings] = await db.accounts.create([{ ownerId, label: 'Everyday account', number: '1024001801', balanceKobo: 124850000 }, { ownerId, label: 'Savings account', number: '1024001802', balanceKobo: 50000000 }], { session, ordered: true });
    await db.entries.create([{ ownerId, accountId: String(everyday._id), reference: 'SEED-EVERYDAY', kind: 'credit', amountKobo: 124850000, description: 'Opening sample balance' }, { ownerId, accountId: String(savings._id), reference: 'SEED-SAVINGS', kind: 'credit', amountKobo: 50000000, description: 'Opening sample savings' }], { session, ordered: true });
  });
}
