process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.SUPABASE_JWT_SECRET = 'test-secret-test-secret-test-secret-123';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { DataRepository } from '../src/supabase/data.repository';

const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
const token = (o: { aud?: string; exp?: string; iss?: string; sub?: string } = {}) =>
  new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(o.sub ?? 'user-1')
    .setIssuer(o.iss ?? 'https://example.supabase.co/auth/v1').setAudience(o.aud ?? 'authenticated')
    .setIssuedAt().setExpirationTime(o.exp ?? '1h').sign(secret);

describe('API (e2e, stubbed data layer)', () => {
  let app: INestApplication; let ping = true;
  const rows = [1, 2, 3].map((n) => ({ entity_type: 'category', entity_id: `c${n}`, version: 1, payload: {}, deleted: false, change_seq: n }));
  const repo = {
    fetchChanges: async (a: number, l: number) => rows.filter((r) => r.change_seq > a).slice(0, l),
    maxChangeSeq: async () => 3, staffRole: async () => null, ping: async () => ping,
  };
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataRepository).useValue(repo).compile();
    app = mod.createNestApplication(); app.enableVersioning({ type: VersioningType.URI }); await app.init();
  });
  afterAll(() => app.close());

  it('liveness is always ok', () => request(app.getHttpServer()).get('/healthz').expect(200));
  it('readiness reflects the data layer', async () => {
    await request(app.getHttpServer()).get('/readyz').expect(200);
    ping = false; await request(app.getHttpServer()).get('/readyz').expect(503); ping = true;
  });
  it('rejects sync without a token', () => request(app.getHttpServer()).get('/v1/sync').expect(401));
  it('rejects an expired token', async () => request(app.getHttpServer()).get('/v1/sync').set('Authorization', `Bearer ${await token({ exp: '-1m' })}`).expect(401));
  it('rejects the wrong audience', async () => request(app.getHttpServer()).get('/v1/sync').set('Authorization', `Bearer ${await token({ aud: 'anon' })}`).expect(401));
  it('rejects a wrong issuer', async () => request(app.getHttpServer()).get('/v1/sync').set('Authorization', `Bearer ${await token({ iss: 'https://evil.example/auth/v1' })}`).expect(401));
  it('serves changes with a valid token', async () => {
    const r = await request(app.getHttpServer()).get('/v1/sync?cursor=1&limit=1').set('Authorization', `Bearer ${await token()}`).expect(200);
    expect(r.body).toEqual({ items: [rows[1]], cursor: 2, hasMore: true });
  });
  it('validates query input', async () => request(app.getHttpServer()).get('/v1/sync?cursor=-5').set('Authorization', `Bearer ${await token()}`).expect(400));
  it('exposes head cursor', async () => {
    const r = await request(app.getHttpServer()).get('/v1/sync/head').set('Authorization', `Bearer ${await token()}`).expect(200);
    expect(r.body).toEqual({ cursor: 3 });
  });
});
