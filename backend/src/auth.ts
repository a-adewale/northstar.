import { Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Injectable, Post, Get, Req, Res, UnauthorizedException, UseGuards, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { compare, hash } from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { Database } from './database';
import { LoginDto, RegisterDto } from './dto';

export type UserRequest = Request & { user: { id: string; name: string; email: string; role: string }; sessionId: string };
export const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.NODE_ENV === 'production', path: '/api' });
@Injectable()
export class AuthService {
  constructor(private db: Database, private jwt: JwtService) {}
  async register(dto: RegisterDto) {
    const passwordHash = await hash(dto.password, 12);
    try {
      return await this.db.connection.transaction(async session => {
        const [user] = await this.db.users.create([{ name: dto.name, email: dto.email, passwordHash, role: 'customer' }], { session });
        for (const label of ['Everyday account', 'Savings account']) {
          await this.db.accounts.create([{ ownerId: String(user._id), label, number: String(randomInt(1000000000, 9999999999)), balanceKobo: 0 }], { session });
        }
        return this.publicUser(user);
      });
    } catch (e: any) { if (e.code === 11000) throw new ConflictException('An account already exists with these details'); throw e; }
  }
  async login(dto: LoginDto) {
    const user = await this.db.users.findOne({ email: dto.email }).select('+passwordHash');
    // Always run a hash check to reduce account-enumeration timing differences.
    const valid = await compare(dto.password, user?.passwordHash ?? '$2b$12$4NSkL63bkrBx0Ld6OcswguKb6i.Fh/eIg1PbIkm/GVtD5soU06IFy');
    if (!user || !valid) throw new UnauthorizedException('Email or password is incorrect');
    const session = await this.db.sessions.create({ userId: String(user._id), expiresAt: new Date(Date.now() + 1800000) });
    return { user: this.publicUser(user), token: await this.jwt.signAsync({ sub: String(user._id), sid: String(session._id) }) };
  }
  publicUser(user: any) { return { id: String(user._id), name: user.name, email: user.email, role: user.role }; }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private db: Database, private jwt: JwtService, private auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<UserRequest>();
    try {
      const payload = await this.jwt.verifyAsync(req.cookies?.bank_session ?? '');
      const session = await this.db.sessions.findOne({ _id: payload.sid, userId: payload.sub, expiresAt: { $gt: new Date() } });
      const user = session && await this.db.users.findById(payload.sub);
      if (!user) throw new Error();
      req.user = this.auth.publicUser(user); req.sessionId = payload.sid;
      return true;
    } catch { throw new UnauthorizedException('Please sign in again'); }
  }
}
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    if (context.switchToHttp().getRequest<UserRequest>().user?.role !== 'admin') throw new ForbiddenException('Administrator access required');
    return true;
  }
}
@ApiTags('Authentication') @Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private db: Database) {}
  @Post('register') @Throttle({ default: { limit: 5, ttl: 60000 } }) register(@Body() body: RegisterDto) { return this.auth.register(body); }
  @Post('login') @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(body);
    res.cookie('bank_session', result.token, { ...cookieOptions(), maxAge: 1800000 });
    return result.user;
  }
  @Get('me') @UseGuards(SessionGuard) @ApiCookieAuth('bank_session') me(@Req() req: UserRequest) { return req.user; }
  @Post('logout') @UseGuards(SessionGuard)
  async logout(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.sessions.deleteOne({ _id: req.sessionId }); res.clearCookie('bank_session', cookieOptions()); return { ok: true };
  }
}
