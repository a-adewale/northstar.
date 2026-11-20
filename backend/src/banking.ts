import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHmac, randomUUID } from 'node:crypto';
import { isValidObjectId } from 'mongoose';
import { Database } from './database';
import { AdminGuard, SessionGuard, UserRequest } from './auth';
import { ExternalTransferDto, HistoryQuery, ResolveBankAccountDto, TransferDto } from './dto';

const banks: Record<string, { name: string; code: string }> = {
  test: { name: 'Paystack Test Bank', code: '001' },
  access: { name: 'Access Bank', code: '044' }, first: { name: 'First Bank', code: '011' },
  gtb: { name: 'Guaranty Trust Bank', code: '058' }, uba: { name: 'United Bank for Africa', code: '033' },
  zenith: { name: 'Zenith Bank', code: '057' }
};
type PaystackResponse<T> = { status: boolean; data?: T };
type PaystackTransfer = { domain: string; reference: string; status: string; amount: number; currency: string; recipient?: { details?: { account_number: string; bank_code: string } } };
class StarterPayoutUnavailable extends Error {}

@Injectable()
export class BankingService {
  constructor(private db: Database) {}
  accounts(ownerId: string) { return this.db.accounts.find({ ownerId }).sort({ createdAt: 1 }).lean(); }
  async history(ownerId: string, query: HistoryQuery) {
    const filter: Record<string, unknown> = { ownerId };
    if (query.accountId) {
      if (!await this.db.accounts.exists({ _id: query.accountId, ownerId })) throw new NotFoundException('Account not found');
      filter.accountId = query.accountId;
    }
    if (query.kind !== 'all') filter.kind = query.kind;
    if (query.search) filter.description = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, total] = await Promise.all([this.db.entries.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * 8).limit(8).lean(), this.db.entries.countDocuments(filter)]);
    return { items, total, page: query.page, pageSize: 8 };
  }
  async transactionDetail(ownerId: string, id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid transaction ID');
    const entry = await this.db.entries.findOne({ _id: id, ownerId }).lean();
    if (!entry) throw new NotFoundException('Transaction not found');
    const account = await this.db.accounts.findOne({ _id: entry.accountId, ownerId }).lean();
    const internal = await this.db.transfers.findOne({ reference: entry.reference, ownerId }).lean();
    const external = internal ? null : await this.db.externalTransfers.findOne({ reference: entry.reference, ownerId }).lean();
    const payment = internal || external ? null : await this.db.payments.findOne({ reference: entry.reference, ownerId }).lean();
    const otherAccountId = internal ? (entry.kind === 'debit' ? internal.toAccountId : internal.fromAccountId) : null;
    const otherAccount = otherAccountId ? await this.db.accounts.findOne({ _id: otherAccountId, ownerId }).lean() : null;
    return {
      id: String(entry._id), reference: entry.reference, kind: entry.kind, amountKobo: entry.amountKobo,
      description: entry.description, createdAt: entry.createdAt, status: 'completed', currency: account?.currency ?? 'NGN',
      account: account ? { label: account.label, last4: account.number.slice(-4) } : null,
      type: internal ? 'Between your accounts' : external ? 'Outgoing bank transfer' : payment ? 'Paystack test payment' : 'Account activity',
      counterparty: otherAccount ? { name: otherAccount.label, last4: otherAccount.number.slice(-4) } : external ? { name: external.recipientName, bank: external.bankName, last4: external.accountLast4 } : null,
      mode: external ? (external.mode ?? 'local-demo') : (payment ? 'paystack-test' : 'internal')
    };
  }
  async transfer(ownerId: string, dto: TransferDto) {
    if (dto.fromAccountId === dto.toAccountId) throw new BadRequestException('Choose two different accounts');
    const replay = (previous: any) => {
      if (['fromAccountId', 'toAccountId', 'amountKobo', 'description'].some(field => previous[field] !== (dto as any)[field])) throw new ConflictException('This request key was already used for a different transfer');
      return { reference: previous.reference, amountKobo: previous.amountKobo, createdAt: previous.createdAt, status: 'completed', replayed: true };
    };
    const existing = await this.db.transfers.findOne({ ownerId, key: dto.key });
    if (existing) return replay(existing);
    try {
      return await this.db.connection.transaction(async session => {
        const prior = await this.db.transfers.findOne({ ownerId, key: dto.key }).session(session);
        if (prior) return replay(prior);
        const from = await this.db.accounts.findOne({ _id: dto.fromAccountId, ownerId }).session(session);
        const to = await this.db.accounts.findOne({ _id: dto.toAccountId, ownerId }).session(session);
        if (!from || !to) throw new NotFoundException('Account not found');
        if (from.currency !== to.currency) throw new BadRequestException('Account currencies must match');
        if (!Number.isSafeInteger(to.balanceKobo + dto.amountKobo)) throw new BadRequestException('Destination balance limit exceeded');
        const debit = await this.db.accounts.updateOne({ _id: from._id, ownerId, balanceKobo: { $gte: dto.amountKobo } }, { $inc: { balanceKobo: -dto.amountKobo } }, { session });
        if (!debit.modifiedCount) throw new BadRequestException('Insufficient funds');
        await this.db.accounts.updateOne({ _id: to._id, ownerId }, { $inc: { balanceKobo: dto.amountKobo } }, { session });
        const reference = `NS-${randomUUID()}`;
        const [transfer] = await this.db.transfers.create([{ ...dto, ownerId, reference }], { session });
        // Two ledger entries share a reference; uniqueness is per account, not per transfer.
        await this.db.entries.create([{ ownerId, accountId: dto.fromAccountId, reference, kind: 'debit', amountKobo: dto.amountKobo, description: dto.description }, { ownerId, accountId: dto.toAccountId, reference, kind: 'credit', amountKobo: dto.amountKobo, description: dto.description }], { session, ordered: true });
        return { reference, amountKobo: dto.amountKobo, createdAt: transfer.createdAt, status: 'completed', replayed: false };
      });
    } catch (e: any) {
      if (e.code === 11000) { const prior = await this.db.transfers.findOne({ ownerId, key: dto.key }); if (prior) return replay(prior); }
      throw e;
    }
  }
  private paystackKey() {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key?.startsWith('sk_test_') || key.length < 15) throw new ServiceUnavailableException('Paystack test key is not configured');
    return key;
  }
  private async paystack<T>(path: string, init?: RequestInit, allowMissing = false): Promise<T | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetch(`https://api.paystack.co/${path}`, { ...init, signal: abort.signal, headers: { Authorization: `Bearer ${this.paystackKey()}`, 'Content-Type': 'application/json' } });
      const body = await response.json() as PaystackResponse<T> & { message?: string };
      if (allowMissing && (response.status === 404 || (response.status === 400 && /transfer.*not found|no transfer.*found/i.test(body.message ?? '')))) return null;
      if (!response.ok || !body.status || !body.data) {
        if (path.startsWith('bank/resolve') && /test mode daily limit/i.test(body.message ?? '')) throw new BadGatewayException('Paystack’s daily test limit for live-bank lookups has been reached. Choose Paystack Test Bank and account 1000000001.');
        if (path === 'transfer' && response.status === 400 && /cannot initiate third party payouts as a starter business/i.test(body.message ?? '')) throw new StarterPayoutUnavailable();
        const stage = path.startsWith('bank/resolve') ? 'verify the bank account' : path === 'transferrecipient' ? 'create a test recipient' : path.startsWith('transfer/verify') ? 'verify the test transfer' : 'initiate the test transfer';
        throw new BadGatewayException(`Paystack could not ${stage}`);
      }
      return body.data;
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof BadGatewayException || error instanceof StarterPayoutUnavailable) throw error;
      throw new BadGatewayException('Paystack is temporarily unavailable');
    } finally { clearTimeout(timer); }
  }
  async resolveBankAccount(dto: ResolveBankAccountDto) {
    const bank = banks[dto.bankCode];
    if (!bank) throw new BadRequestException('Choose a supported bank');
    const params = new URLSearchParams({ account_number: dto.accountNumber, bank_code: bank.code });
    const resolved = await this.paystack<{ account_number: string; account_name: string }>(`bank/resolve?${params}`);
    if (!resolved?.account_name || resolved.account_number !== dto.accountNumber) throw new BadGatewayException('Paystack could not verify this account');
    return { bankName: bank.name, accountName: resolved.account_name, accountLast4: dto.accountNumber.slice(-4) };
  }
  async externalTransfer(ownerId: string, dto: ExternalTransferDto) {
    const bank = banks[dto.bankCode];
    if (!bank) throw new BadRequestException('Choose a supported bank');
    const accountHash = createHmac('sha256', process.env.JWT_SECRET!).update(`${dto.bankCode}:${dto.accountNumber}`).digest('hex');
    const description = dto.description.trim();
    if (description.length < 3) throw new BadRequestException('Enter a transfer note');
    const replay = (previous: any) => {
      if (previous.fromAccountId !== dto.fromAccountId || previous.bankCode !== dto.bankCode || previous.accountHash !== accountHash || previous.amountKobo !== dto.amountKobo || previous.description !== description) throw new ConflictException('This request key was already used for a different transfer');
      return { reference: previous.reference, amountKobo: previous.amountKobo, status: previous.mode === 'local-demo' ? 'simulated' : 'test_success', mode: previous.mode ?? 'paystack-test', replayed: true };
    };
    const existing = await this.db.externalTransfers.findOne({ ownerId, key: dto.key });
    if (existing) return replay(existing);
    const from = await this.db.accounts.findOne({ _id: dto.fromAccountId, ownerId });
    if (!from) throw new NotFoundException('Account not found');
    if (from.currency !== 'NGN') throw new BadRequestException('Only NGN test transfers are supported');
    if (from.balanceKobo < dto.amountKobo) throw new BadRequestException('Insufficient funds');
    const reference = `nse_${createHmac('sha256', process.env.JWT_SECRET!).update(`${ownerId}:${dto.key}`).digest('hex').slice(0, 32)}`;
    let providerTransfer = dto.bankCode === 'test' ? null : await this.paystack<PaystackTransfer>(`transfer/verify/${reference}`, undefined, true);
    let mode: 'paystack-test' | 'local-demo' = 'paystack-test';
    let accountName: string;
    if (!providerTransfer) {
      const resolved = await this.resolveBankAccount({ bankCode: dto.bankCode, accountNumber: dto.accountNumber });
      accountName = resolved.accountName;
      if (dto.bankCode === 'test') {
        mode = 'local-demo';
      } else {
      const recipient = await this.paystack<{ domain: string; recipient_code: string; details: { account_number: string; bank_code: string } }>('transferrecipient', { method: 'POST', body: JSON.stringify({ type: 'nuban', name: accountName, account_number: dto.accountNumber, bank_code: bank.code, currency: 'NGN' }) });
      if (recipient?.domain !== 'test' || !recipient.recipient_code || recipient.details.account_number !== dto.accountNumber || recipient.details.bank_code !== bank.code) throw new BadGatewayException('Paystack returned an unexpected recipient');
      try {
        const initiated = await this.paystack<PaystackTransfer>('transfer', { method: 'POST', body: JSON.stringify({ source: 'balance', amount: dto.amountKobo, reference, recipient: recipient.recipient_code, reason: description, currency: 'NGN' }) });
        if (initiated?.domain !== 'test' || initiated.reference !== reference || initiated.amount !== dto.amountKobo || initiated.currency !== 'NGN') throw new BadGatewayException('Paystack returned unexpected transfer details');
        providerTransfer = await this.paystack<PaystackTransfer>(`transfer/verify/${reference}`);
      } catch (error) {
        if (!(error instanceof StarterPayoutUnavailable)) throw error;
        mode = 'local-demo';
      }
      }
    } else {
      const resolved = await this.resolveBankAccount({ bankCode: dto.bankCode, accountNumber: dto.accountNumber });
      accountName = resolved.accountName;
    }
    if (mode === 'paystack-test' && (!providerTransfer || providerTransfer.domain !== 'test' || providerTransfer.reference !== reference || providerTransfer.amount !== dto.amountKobo || providerTransfer.currency !== 'NGN' || providerTransfer.status !== 'success' || providerTransfer.recipient?.details?.account_number !== dto.accountNumber || providerTransfer.recipient.details.bank_code !== bank.code)) throw new BadGatewayException('Paystack test transfer was not confirmed');
    try {
      return await this.db.connection.transaction(async session => {
        const prior = await this.db.externalTransfers.findOne({ ownerId, key: dto.key }).session(session);
        if (prior) return replay(prior);
        const debit = await this.db.accounts.updateOne({ _id: dto.fromAccountId, ownerId, balanceKobo: { $gte: dto.amountKobo } }, { $inc: { balanceKobo: -dto.amountKobo } }, { session });
        if (!debit.modifiedCount) throw new BadRequestException('Insufficient funds');
        await this.db.externalTransfers.create([{ ownerId, key: dto.key, fromAccountId: dto.fromAccountId, bankCode: dto.bankCode, bankName: bank.name, accountLast4: dto.accountNumber.slice(-4), accountHash, recipientName: accountName, amountKobo: dto.amountKobo, description, reference, status: 'completed', mode }], { session });
        await this.db.entries.create([{ ownerId, accountId: dto.fromAccountId, reference, kind: 'debit', amountKobo: dto.amountKobo, description: `${description} · ${bank.name} ••••${dto.accountNumber.slice(-4)} (${mode === 'local-demo' ? 'local demo' : 'Paystack test'})` }], { session });
        return { reference, amountKobo: dto.amountKobo, status: mode === 'local-demo' ? 'simulated' : 'test_success', mode, replayed: false };
      });
    } catch (e: any) {
      if (e.code === 11000) { const prior = await this.db.externalTransfers.findOne({ ownerId, key: dto.key }); if (prior) return replay(prior); }
      throw e;
    }
  }
}
@ApiTags('Banking') @ApiCookieAuth('bank_session') @UseGuards(SessionGuard) @Controller()
export class BankingController {
  constructor(private service: BankingService, private db: Database) {}
  @Get('accounts') accounts(@Req() req: UserRequest) { return this.service.accounts(req.user.id); }
  @Get('transactions') history(@Req() req: UserRequest, @Query() query: HistoryQuery) { return this.service.history(req.user.id, query); }
  @Get('transactions/:id') @ApiOperation({ summary: 'Details for one of your transactions' }) transactionDetail(@Req() req: UserRequest, @Param('id') id: string) { return this.service.transactionDetail(req.user.id, id); }
  @Post('transfers') @ApiOperation({ summary: 'Transfer between your own accounts, with atomic balances and duplicate prevention' }) transfer(@Req() req: UserRequest, @Body() dto: TransferDto) { return this.service.transfer(req.user.id, dto); }
  @Get('external-transfers/resolve') @ApiOperation({ summary: 'Resolve a Nigerian bank account using Paystack test mode' }) resolveBankAccount(@Query() dto: ResolveBankAccountDto) { return this.service.resolveBankAccount(dto); }
  @Post('external-transfers') @ApiOperation({ summary: 'Initiate a Paystack test transfer; no real funds reach another bank' }) externalTransfer(@Req() req: UserRequest, @Body() dto: ExternalTransferDto) { return this.service.externalTransfer(req.user.id, dto); }
  @Get('admin/summary') @UseGuards(AdminGuard)
  async summary() { return { customers: await this.db.users.countDocuments({ role: 'customer' }), accounts: await this.db.accounts.countDocuments(), transfers: await this.db.transfers.countDocuments() }; }
}
