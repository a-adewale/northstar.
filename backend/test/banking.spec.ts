import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { createApp } from '../src/app';
import { Database } from '../src/database';
import { BankingService } from '../src/banking';
import { seed } from '../src/seed';

describe('Banking API against a real MongoDB replica set', () => {
  let mongo: MongoMemoryReplSet;
  let app: INestApplication;
  let db: Database;
  let cookie: string;
  let accounts: any[];
  let ownerId: string;
  const origin = 'http://localhost:5187';
  const payload = (amountKobo = 250000) => ({ fromAccountId: String(accounts[0]._id), toAccountId: String(accounts[1]._id), amountKobo, description: 'Monthly savings', key: randomUUID() });
  beforeAll(async () => {
    process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = randomBytes(48).toString('hex'); process.env.WEB_ORIGIN = origin;
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    process.env.MONGODB_URI = mongo.getUri('tests');
    app = await createApp(); db = app.get(Database); await seed(db);
    const login = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ email: 'ada@example.com', password: 'Northstar123!' }).expect(201);
    cookie = login.headers['set-cookie'][0].split(';')[0]; ownerId = login.body.id;
    accounts = (await request(app.getHttpServer()).get('/api/accounts').set('Cookie', cookie).expect(200)).body;
  });
  afterAll(async () => { await app?.close(); await mongo?.stop(); });
  it('requires authentication and uses an HTTP-only SameSite cookie', async () => {
    await request(app.getHttpServer()).get('/api/accounts').expect(401);
    const result = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'ada@example.com', password: 'Northstar123!' }).expect(201);
    expect(result.headers['set-cookie'][0]).toContain('HttpOnly'); expect(result.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect(result.body).not.toHaveProperty('passwordHash'); expect(result.body).not.toHaveProperty('token');
  });
  it('registers zero-balance accounts and rejects duplicate emails and role injection', async () => {
    const body = { name: 'Other customer', email: 'other@example.com', password: 'StrongPass123!' };
    await request(app.getHttpServer()).post('/api/auth/register').send(body).expect(201);
    await request(app.getHttpServer()).post('/api/auth/register').send(body).expect(409);
    await request(app.getHttpServer()).post('/api/auth/register').send({ ...body, email: 'admin@example.com', role: 'admin' }).expect(400);
    const user = await db.users.findOne({ email: body.email });
    const rows = await db.accounts.find({ ownerId: String(user!._id) });
    expect(rows).toHaveLength(2); expect(rows.every(row => row.balanceKobo === 0)).toBe(true);
  });
  it('rejects weak passwords and invalid credentials', async () => {
    await request(app.getHttpServer()).post('/api/auth/register').send({ name: 'Test', email: 'weak@example.com', password: 'short' }).expect(400);
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'ada@example.com', password: 'wrong' }).expect(401);
  });
  it('rejects bad origins, invalid IDs, fractional money, and self transfers', async () => {
    for (const body of [{ ...payload(), amountKobo: 0.5 }, { ...payload(), amountKobo: -100 }, { ...payload(), fromAccountId: 'invalid' }, { ...payload(), toAccountId: String(accounts[0]._id) }]) {
      await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(400);
    }
    await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', 'https://untrusted.example').send(payload()).expect(403);
    await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).send(payload()).expect(403);
  });
  it('prevents access to another customer’s history and accounts', async () => {
    const other = await db.accounts.findOne({ ownerId: { $ne: ownerId } });
    await request(app.getHttpServer()).get(`/api/transactions?accountId=${other!._id}`).set('Cookie', cookie).expect(404);
    await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send({ ...payload(), toAccountId: String(other!._id) }).expect(404);
    expect((await db.accounts.findById(other!._id))!.balanceKobo).toBe(0);
  });
  it('moves money atomically and creates matching ledger entries', async () => {
    const body = payload(); const before = await db.accounts.find({ ownerId }).sort({ createdAt: 1 }).lean();
    const result = await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(201);
    const after = await db.accounts.find({ ownerId }).sort({ createdAt: 1 }).lean();
    expect(after[0].balanceKobo).toBe(before[0].balanceKobo - body.amountKobo); expect(after[1].balanceKobo).toBe(before[1].balanceKobo + body.amountKobo);
    const entries = await db.entries.find({ reference: result.body.reference }); expect(entries).toHaveLength(2);
    expect(entries.reduce((sum,e)=>sum+(e.kind==='credit'?e.amountKobo:-e.amountKobo),0)).toBe(0);
    const retry = await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(201);
    expect(retry.body.reference).toBe(result.body.reference); expect(retry.body.replayed).toBe(true);
    await request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send({ ...body, amountKobo: 100 }).expect(409);
    expect(await db.entries.countDocuments({ reference: result.body.reference })).toBe(2);
  });
  it('confirms a Paystack test transfer before debiting and stores only masked bank details', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_test_key_123456';
    let initiated = false;
    let transferReference = '';
    let providerAmount = 5001;
    const provider = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/bank/resolve?')) return new Response(JSON.stringify({ status: true, data: { account_number: '1000000001', account_name: 'Test Recipient' } }), { status: 200 });
      if (url.endsWith('/transferrecipient')) return new Response(JSON.stringify({ status: true, data: { domain: 'test', recipient_code: 'RCP_test', details: { account_number: '1000000001', bank_code: '057' } } }), { status: 200 });
      if (url.endsWith('/transfer')) {
        const body = JSON.parse(String(init?.body));
        transferReference = body.reference; initiated = true;
        return new Response(JSON.stringify({ status: true, data: { domain: 'test', reference: body.reference, amount: body.amount, currency: 'NGN', status: 'success' } }), { status: 200 });
      }
      if (url.includes('/transfer/verify/')) {
        if (!initiated) return new Response(JSON.stringify({ status: false, message: 'Transfer not found' }), { status: 400 });
        return new Response(JSON.stringify({ status: true, data: { domain: 'test', reference: transferReference, amount: providerAmount, currency: 'NGN', status: 'success', recipient: { details: { account_number: '1000000001', bank_code: '057' } } } }), { status: 200 });
      }
      throw new Error('Unexpected Paystack endpoint');
    });
    try {
      const fromAccountId = String(accounts[1]._id);
      const body = { fromAccountId, bankCode: 'zenith', accountNumber: '1000000001', amountKobo: 5000, description: 'Demo bank transfer', key: randomUUID() };
      const before = (await db.accounts.findById(fromAccountId))!.balanceKobo;
      await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send({ ...body, accountNumber: '123' }).expect(400);
      const other = await db.accounts.findOne({ ownerId: { $ne: ownerId } });
      await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send({ ...body, fromAccountId: String(other!._id) }).expect(404);
      const resolved = await request(app.getHttpServer()).get('/api/external-transfers/resolve?bankCode=zenith&accountNumber=1000000001').set('Cookie', cookie).expect(200);
      expect(resolved.body.accountName).toBe('Test Recipient');
      await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(502);
      expect((await db.accounts.findById(fromAccountId))!.balanceKobo).toBe(before);
      providerAmount = 5000;
      const first = await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(201);
      expect(first.body.status).toBe('test_success');
      const calls = provider.mock.calls.length;
      const retry = await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(201);
      expect(retry.body.reference).toBe(first.body.reference);
      expect(retry.body.replayed).toBe(true);
      expect(provider.mock.calls.length).toBe(calls);
      await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send({ ...body, accountNumber: '1000000002' }).expect(409);
      expect((await db.accounts.findById(fromAccountId))!.balanceKobo).toBe(before - 5000);
      expect(await db.entries.countDocuments({ reference: first.body.reference })).toBe(1);
      const saved = (await db.externalTransfers.findOne({ reference: first.body.reference }))!.toObject();
      expect(saved.accountLast4).toBe('0001');
      expect(saved.recipientName).toBe('Test Recipient');
      expect(JSON.stringify(saved)).not.toContain('1000000001');
    } finally { provider.mockRestore(); delete process.env.PAYSTACK_SECRET_KEY; }
  });
  it('falls back to a clearly marked local demo when Starter payouts are unavailable', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_test_key_123456';
    const provider = jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/transfer/verify/')) return new Response(JSON.stringify({ status: false, message: 'Transfer not found' }), { status: 404 });
      if (url.includes('/bank/resolve?')) return new Response(JSON.stringify({ status: true, data: { account_number: '1000000001', account_name: 'Test Recipient' } }), { status: 200 });
      if (url.endsWith('/transferrecipient')) return new Response(JSON.stringify({ status: true, data: { domain: 'test', recipient_code: 'RCP_test', details: { account_number: '1000000001', bank_code: '057' } } }), { status: 200 });
      if (url.endsWith('/transfer')) return new Response(JSON.stringify({ status: false, message: 'You cannot initiate third party payouts as a starter business' }), { status: 400 });
      throw new Error('Unexpected Paystack endpoint');
    });
    try {
      const fromAccountId = String(accounts[1]._id);
      const before = (await db.accounts.findById(fromAccountId))!.balanceKobo;
      const body = { fromAccountId, bankCode: 'zenith', accountNumber: '1000000001', amountKobo: 1000, description: 'Starter fallback', key: randomUUID() };
      const result = await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send(body).expect(201);
      expect(result.body).toMatchObject({ mode: 'local-demo', status: 'simulated' });
      expect((await db.accounts.findById(fromAccountId))!.balanceKobo).toBe(before - 1000);
      expect((await db.entries.findOne({ reference: result.body.reference }))!.description).toContain('local demo');
      const callsBefore = provider.mock.calls.length;
      const testBank = await request(app.getHttpServer()).post('/api/external-transfers').set('Cookie', cookie).set('Origin', origin).send({ ...body, bankCode: 'test', key: randomUUID() }).expect(201);
      expect(testBank.body).toMatchObject({ mode: 'local-demo', status: 'simulated' });
      expect(provider.mock.calls.slice(callsBefore).map(call => String(call[0]))).toEqual(['https://api.paystack.co/bank/resolve?account_number=1000000001&bank_code=001']);
    } finally { provider.mockRestore(); delete process.env.PAYSTACK_SECRET_KEY; }
  });
  it('returns transaction details only for the signed-in account owner', async () => {
    const external = await db.externalTransfers.findOne({ ownerId });
    const entry = await db.entries.findOne({ reference: external!.reference });
    const result = await request(app.getHttpServer()).get(`/api/transactions/${entry!._id}`).set('Cookie', cookie).expect(200);
    expect(result.body.type).toBe('Outgoing bank transfer');
    expect(result.body.counterparty).toMatchObject({ bank: 'Zenith Bank', last4: '0001', name: 'Test Recipient' });
    expect(result.body).not.toHaveProperty('accountNumber');
    await request(app.getHttpServer()).get('/api/transactions/not-an-id').set('Cookie', cookie).expect(400);
    await request(app.getHttpServer()).get(`/api/transactions/${new Types.ObjectId()}`).set('Cookie', cookie).expect(404);
  });
  it('filters and paginates history without interpreting regex input', async () => {
    const result = await request(app.getHttpServer()).get('/api/transactions?kind=debit&search=Monthly&page=1').set('Cookie', cookie).expect(200);
    expect(result.body.total).toBe(1); expect(result.body.items[0].kind).toBe('debit');
    const literal = await request(app.getHttpServer()).get('/api/transactions?search=.*').set('Cookie', cookie).expect(200); expect(literal.body.total).toBe(0);
  });
  it('rolls balances back if ledger writing fails', async () => {
    const before = await db.accounts.findById(accounts[0]._id);
    const failure = jest.spyOn(db.entries, 'create').mockRejectedValueOnce(new Error('Simulated ledger outage'));
    await expect(app.get(BankingService).transfer(ownerId, payload(500))).rejects.toThrow('Simulated ledger outage');
    failure.mockRestore();
    expect((await db.accounts.findById(accounts[0]._id))!.balanceKobo).toBe(before!.balanceKobo);
  });
  it('allows only admins to read the operations summary', async () => {
    await request(app.getHttpServer()).get('/api/admin/summary').set('Cookie', cookie).expect(403);
    await db.users.updateOne({ _id: ownerId }, { role: 'admin' });
    const result = await request(app.getHttpServer()).get('/api/admin/summary').set('Cookie', cookie).expect(200);
    expect(result.body.transfers).toBeGreaterThan(0);
    await db.users.updateOne({ _id: ownerId }, { role: 'customer' });
  });
  it('does not overdraw during concurrent transfers', async () => {
    await db.accounts.updateOne({ _id: accounts[0]._id }, { balanceKobo: 10000 });
    const results = await Promise.all([1,2].map(()=>request(app.getHttpServer()).post('/api/transfers').set('Cookie', cookie).set('Origin', origin).send(payload(8000))));
    expect(results.map(r=>r.status).sort()).toEqual([201,400]); expect((await db.accounts.findById(accounts[0]._id))!.balanceKobo).toBe(2000);
  });
  it('credits a verified Paystack test payment exactly once', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_test_key_123456';
    let providerAmount = 50000;
    let providerReference = '';
    const provider = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/initialize')) {
        const body = JSON.parse(String(init?.body)); providerReference = body.reference;
        return new Response(JSON.stringify({ status: true, data: { reference: body.reference, authorization_url: 'https://checkout.paystack.com/test-checkout' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: true, data: { status: 'success', domain: 'test', reference: providerReference, amount: providerAmount, currency: 'NGN', customer: { email: 'ada@example.com' } } }), { status: 200 });
    });
    try {
      const accountId = String(accounts[1]._id);
      const before = (await db.accounts.findById(accountId))!.balanceKobo;
      const init = await request(app.getHttpServer()).post('/api/payments/initialize').set('Cookie', cookie).set('Origin', origin).send({ accountId, amountKobo: 50000 }).expect(201);
      expect(init.body.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
      providerAmount = 10000;
      await request(app.getHttpServer()).post('/api/payments/verify').set('Cookie', cookie).set('Origin', origin).send({ reference: init.body.reference }).expect(502);
      expect((await db.accounts.findById(accountId))!.balanceKobo).toBe(before);
      providerAmount = 50000;
      await request(app.getHttpServer()).post('/api/payments/verify').set('Cookie', cookie).set('Origin', origin).send({ reference: init.body.reference }).expect(201);
      await request(app.getHttpServer()).post('/api/payments/verify').set('Cookie', cookie).set('Origin', origin).send({ reference: init.body.reference }).expect(201);
      expect((await db.accounts.findById(accountId))!.balanceKobo).toBe(before + 50000);
      expect(await db.entries.countDocuments({ reference: init.body.reference })).toBe(1);
    } finally { provider.mockRestore(); delete process.env.PAYSTACK_SECRET_KEY; }
  });
  it('revokes the server session on logout', async () => {
    await request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).set('Origin', origin).expect(201);
    await request(app.getHttpServer()).get('/api/accounts').set('Cookie', cookie).expect(401);
  });
});
