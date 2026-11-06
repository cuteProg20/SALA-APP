import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey } from 'jose';
import { loadEnv } from '../config/env';

export interface AuthUser { id: string; }

/** Verifies a Supabase-issued access token. Does NOT trust role claims: staff roles come from the database. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly secret?: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor() {
    const env = loadEnv();
    this.issuer = `${env.SUPABASE_URL}/auth/v1`;
    if (env.SUPABASE_JWT_SECRET) this.secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
    else this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const token = header.slice(7);
      const opts = { issuer: this.issuer, audience: 'authenticated' };
      const { payload } = this.secret
        ? await jwtVerify(token, this.secret, { ...opts, algorithms: ['HS256'] })
        : await jwtVerify(token, this.jwks!, { ...opts, algorithms: ['ES256', 'RS256'] });
      if (!payload.sub) throw new Error('no subject');
      req.user = { id: payload.sub } satisfies AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException(); // no detail on purpose
    }
  }
}
