import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createApp } from './app';
import { Database } from './database';
import { seed } from './seed';
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Use npm start for production');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.startsWith('replace-')) process.env.JWT_SECRET = randomBytes(48).toString('hex');
  let mongo: MongoMemoryReplSet | undefined;
  if (!process.env.MONGODB_URI) {
    console.log('Starting temporary MongoDB replica set. First run downloads MongoDB; data resets when stopped.');
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = mongo.getUri('northstar');
  }
  const app = await createApp();
  await seed(app.get(Database));
  await app.listen(Number(process.env.PORT ?? 3100), '127.0.0.1');
  console.log('API: http://localhost:3100/api | Docs: http://localhost:3100/docs');
  console.log('Local sample login: ada@example.com / Northstar123!');
  const stop = async () => { await app.close(); await mongo?.stop(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
