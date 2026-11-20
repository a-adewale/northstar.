import 'reflect-metadata';
import { Controller, Get, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { Database } from './database';
import { AdminGuard, AuthController, AuthService, SessionGuard } from './auth';
import { BankingController, BankingService } from './banking';
import { PaymentsController, PaymentsService } from './payments';

@Controller('health')
class HealthController { constructor(private db: Database) {} @Get() health() { return { status: this.db.connection.readyState === 1 ? 'ok' : 'unavailable' }; } }
export async function createApp() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('replace-')) throw new Error('Set JWT_SECRET to a random secret of at least 32 characters');
  @Module({ imports: [JwtModule.register({ secret, signOptions: { expiresIn: '30m', issuer: 'northstar' }, verifyOptions: { issuer: 'northstar' } }), ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }])], controllers: [AuthController, BankingController, PaymentsController, HealthController], providers: [Database, AuthService, SessionGuard, AdminGuard, BankingService, PaymentsService, { provide: APP_GUARD, useClass: ThrottlerGuard }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: process.env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'] });
  app.setGlobalPrefix('api');
  app.use(helmet()); app.use(cookieParser());
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5187';
  app.enableCors({ origin: webOrigin, credentials: true });
  app.use((req: any, res: any, next: () => void) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowed = [webOrigin, `http://localhost:${process.env.PORT ?? 3100}`];
      if ((req.headers.origin && !allowed.includes(req.headers.origin)) || (req.cookies?.bank_session && !req.headers.origin)) return res.status(403).json({ message: 'Untrusted request origin' });
    }
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  const docs = new DocumentBuilder().setTitle('Northstar banking API').setDescription('Local portfolio application. Sign in through /api/auth/login to set the session cookie, then use the protected routes. Internal transfers use simulated funds. Outgoing bank transfers call Paystack test APIs but move no real money.').setVersion('1.0').addCookieAuth('bank_session').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, docs));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
