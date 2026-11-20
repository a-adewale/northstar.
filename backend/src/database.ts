import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Connection, createConnection, Schema, Model } from 'mongoose';
interface UserRecord { name: string; email: string; passwordHash: string; role: 'customer' | 'admin'; }
interface AccountRecord { ownerId: string; label: string; number: string; currency: string; balanceKobo: number; createdAt: Date; }
interface TransferRecord { ownerId: string; key: string; fromAccountId: string; toAccountId: string; amountKobo: number; description: string; reference: string; createdAt: Date; }
interface EntryRecord { ownerId: string; accountId: string; reference: string; kind: 'credit' | 'debit'; amountKobo: number; description: string; createdAt: Date; }
interface SessionRecord { userId: string; expiresAt: Date; }
interface PaymentRecord { ownerId: string; accountId: string; reference: string; amountKobo: number; email: string; status: 'pending' | 'paid'; createdAt: Date; }
interface ExternalTransferRecord { ownerId: string; key: string; fromAccountId: string; bankCode: string; bankName: string; accountLast4: string; accountHash: string; recipientName: string; amountKobo: number; description: string; reference: string; status: 'completed'; mode: 'paystack-test' | 'local-demo'; createdAt: Date; }

@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  connection: Connection;
  users: Model<UserRecord>;
  accounts: Model<AccountRecord>;
  transfers: Model<TransferRecord>;
  entries: Model<EntryRecord>;
  sessions: Model<SessionRecord>;
  payments: Model<PaymentRecord>;
  externalTransfers: Model<ExternalTransferRecord>;
  async onModuleInit() {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    this.connection = await createConnection(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).asPromise();
    const user = new Schema({ name: { type: String, required: true }, email: { type: String, unique: true, required: true }, passwordHash: { type: String, required: true, select: false }, role: { type: String, enum: ['customer', 'admin'], default: 'customer' } }, { timestamps: true });
    const account = new Schema({ ownerId: { type: String, required: true, index: true }, label: String, number: { type: String, unique: true }, currency: { type: String, default: 'NGN' }, balanceKobo: { type: Number, required: true, min: 0, max: Number.MAX_SAFE_INTEGER } }, { timestamps: true });
    const transfer = new Schema({ ownerId: String, key: String, fromAccountId: String, toAccountId: String, amountKobo: Number, description: String, reference: { type: String, unique: true } }, { timestamps: true });
    transfer.index({ ownerId: 1, key: 1 }, { unique: true });
    const entry = new Schema({ ownerId: String, accountId: String, reference: String, kind: { type: String, enum: ['credit', 'debit'] }, amountKobo: Number, description: String }, { timestamps: true });
    entry.index({ ownerId: 1, accountId: 1, createdAt: -1 });
    entry.index({ reference: 1, accountId: 1 }, { unique: true });
    const session = new Schema({ userId: { type: String, index: true }, expiresAt: { type: Date, expires: 0 } });
    const payment = new Schema({ ownerId: { type: String, required: true, index: true }, accountId: { type: String, required: true }, reference: { type: String, required: true, unique: true }, amountKobo: { type: Number, required: true }, email: { type: String, required: true }, status: { type: String, enum: ['pending', 'paid'], default: 'pending' } }, { timestamps: true });
    const externalTransfer = new Schema({ ownerId: { type: String, required: true, index: true }, key: { type: String, required: true }, fromAccountId: { type: String, required: true }, bankCode: { type: String, required: true }, bankName: { type: String, required: true }, accountLast4: { type: String, required: true }, accountHash: { type: String, required: true }, recipientName: { type: String, required: true }, amountKobo: { type: Number, required: true }, description: { type: String, required: true }, reference: { type: String, required: true, unique: true }, status: { type: String, enum: ['completed'], default: 'completed' }, mode: { type: String, enum: ['paystack-test', 'local-demo'], required: true } }, { timestamps: true });
    externalTransfer.index({ ownerId: 1, key: 1 }, { unique: true });
    this.users = this.connection.model<UserRecord>('User', user);
    this.accounts = this.connection.model<AccountRecord>('Account', account);
    this.transfers = this.connection.model<TransferRecord>('Transfer', transfer);
    this.entries = this.connection.model<EntryRecord>('LedgerEntry', entry);
    this.sessions = this.connection.model<SessionRecord>('Session', session);
    this.payments = this.connection.model<PaymentRecord>('Payment', payment);
    this.externalTransfers = this.connection.model<ExternalTransferRecord>('ExternalTransfer', externalTransfer);
    await Promise.all([this.users.init(), this.accounts.init(), this.transfers.init(), this.entries.init(), this.sessions.init(), this.payments.init(), this.externalTransfers.init()]);
  }
  async onModuleDestroy() { await this.connection?.close(); }
}
