import { BadGatewayException, BadRequestException, Body, Controller, ForbiddenException, Injectable, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsMongoId, IsString, Matches, Max, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Database } from './database';
import { SessionGuard, UserRequest } from './auth';

class InitializePaymentDto {
  @ApiProperty() @IsMongoId() accountId: string;
  @ApiProperty({ description: 'Amount in whole kobo' }) @IsInt() @Min(10000) @Max(100000000) amountKobo: number;
}
class VerifyPaymentDto {
  @ApiProperty() @IsString() @Matches(/^NSP-[a-f0-9-]{36}$/) reference: string;
}
type ProviderResponse<T> = { status: boolean; message?: string; data: T };
type ProviderVerify = { status: string; domain: string; reference: string; amount: number; currency: string; customer: { email: string } };

@Injectable()
export class PaymentsService {
  constructor(private db: Database) {}
  private key() {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key || !key.startsWith('sk_test_') || key.length < 15) throw new ServiceUnavailableException('Paystack test key is not configured');
    return key;
  }
  private async paystack<T>(path: string, init?: RequestInit): Promise<T> {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await fetch(`https://api.paystack.co/transaction/${path}`, { ...init, signal: abort.signal, headers: { Authorization: `Bearer ${this.key()}`, 'Content-Type': 'application/json' } });
      const body = await response.json() as ProviderResponse<T>;
      if (!response.ok || !body.status || !body.data) throw new BadGatewayException('Paystack could not complete the request');
      return body.data;
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof BadGatewayException) throw error;
      throw new BadGatewayException('Paystack is temporarily unavailable');
    } finally { clearTimeout(timer); }
  }
  async initialize(user: UserRequest['user'], dto: InitializePaymentDto) {
    const account = await this.db.accounts.findOne({ _id: dto.accountId, ownerId: user.id });
    if (!account) throw new ForbiddenException('Account does not belong to you');
    const reference = `NSP-${randomUUID()}`;
    const origin = process.env.WEB_ORIGIN ?? 'http://localhost:5187';
    const data = await this.paystack<{ authorization_url: string; reference: string }>('initialize', { method: 'POST', body: JSON.stringify({ email: user.email, amount: dto.amountKobo, currency: 'NGN', reference, callback_url: `${origin}/?payment=${encodeURIComponent(reference)}` }) });
    const checkout = new URL(data.authorization_url);
    if (data.reference !== reference || checkout.protocol !== 'https:' || checkout.hostname !== 'checkout.paystack.com') throw new BadGatewayException('Paystack returned an unexpected checkout');
    await this.db.payments.create({ ownerId: user.id, accountId: dto.accountId, reference, amountKobo: dto.amountKobo, email: user.email, status: 'pending' });
    return { authorizationUrl: checkout.href, reference };
  }
  async verify(ownerId: string, reference: string) {
    const payment = await this.db.payments.findOne({ reference, ownerId });
    if (!payment) throw new ForbiddenException('Payment does not belong to you');
    if (payment.status === 'paid') return { reference, status: 'paid', amountKobo: payment.amountKobo, replayed: true };
    const result = await this.paystack<ProviderVerify>(`verify/${encodeURIComponent(reference)}`);
    if (result.status !== 'success') return { reference, status: 'pending', amountKobo: payment.amountKobo };
    if (result.domain !== 'test' || result.reference !== reference || result.amount !== payment.amountKobo || result.currency !== 'NGN' || result.customer?.email?.toLowerCase() !== payment.email.toLowerCase()) throw new BadGatewayException('Payment details did not match the original request');
    await this.db.connection.transaction(async session => {
      const marked = await this.db.payments.updateOne({ _id: payment._id, status: 'pending' }, { $set: { status: 'paid' } }, { session });
      if (!marked.modifiedCount) return;
      const credited = await this.db.accounts.updateOne({ _id: payment.accountId, ownerId, balanceKobo: { $lte: Number.MAX_SAFE_INTEGER - payment.amountKobo } }, { $inc: { balanceKobo: payment.amountKobo } }, { session });
      if (!credited.modifiedCount) throw new BadRequestException('Account could not be credited');
      await this.db.entries.create([{ ownerId, accountId: payment.accountId, reference, kind: 'credit', amountKobo: payment.amountKobo, description: 'Paystack test payment' }], { session });
    });
    return { reference, status: 'paid', amountKobo: payment.amountKobo, replayed: false };
  }
}

@ApiTags('Paystack test payments') @ApiCookieAuth('bank_session') @UseGuards(SessionGuard) @Controller('payments')
export class PaymentsController {
  constructor(private payments: PaymentsService) {}
  @Post('initialize') initialize(@Req() req: UserRequest, @Body() dto: InitializePaymentDto) { return this.payments.initialize(req.user, dto); }
  @Post('verify') verify(@Req() req: UserRequest, @Body() dto: VerifyPaymentDto) { return this.payments.verify(req.user.id, dto.reference); }
}
