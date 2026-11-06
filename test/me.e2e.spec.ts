process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.SUPABASE_JWT_SECRET = 'test-secret-test-secret-test-secret-123';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { SignJWT } from 'jose';
import { AppModule } from '../src/app.module';
import { DataRepository } from '../src/supabase/data.repository';
import { FakeRepo } from './fake-repo';

const key = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
const tok = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
  .setIssuer('https://example.supabase.co/auth/v1').setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(key);
const ID = '22222222-2222-4222-8222-222222222222';

describe('end-user API (/v1/me)', () => {
  let app: INestApplication; let repo: FakeRepo;
  const api = () => request(app.getHttpServer());
  const as = async (u = 'u1') => ({ Authorization: `Bearer ${await tok(u)}` });
  beforeEach(async () => {
    repo = new FakeRepo(); repo.phones.set('u1', '+255700000001'); repo.phones.set('u2', '+255700000002');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataRepository).useValue(repo).compile();
    app = mod.createNestApplication(); app.enableVersioning({ type: VersioningType.URI }); await app.init();
  });
  afterEach(() => app.close());
  const reg = { first_name: 'Asha', last_name: 'Mushi', age: 30 };

  it('needs a token', async () => { await api().get('/v1/me').expect(401); });
  it('reports profile_required until registration is completed', async () => {
    const r = await api().get('/v1/me').set(await as()).expect(404);
    expect(r.body.code).toBe('profile_required');
  });
  it('registers using the verified phone number, never one from the request body', async () => {
    const r = await api().post('/v1/me').set(await as()).send(reg).expect(201);
    expect(r.body.phone_e164).toBe('+255700000001');
    await api().post('/v1/me').set(await as('u2')).send({ ...reg, phone_e164: '+255799999999' }).expect(400); // unknown field rejected
  });
  it('enforces the minimum age and blocks double registration', async () => {
    await api().post('/v1/me').set(await as()).send({ ...reg, age: 12 }).expect(400);
    await api().post('/v1/me').set(await as()).send(reg).expect(201);
    await api().post('/v1/me').set(await as()).send(reg).expect(409);
  });
  it('lets a user change only allowed profile fields', async () => {
    await api().post('/v1/me').set(await as()).send(reg).expect(201);
    await api().patch('/v1/me').set(await as()).send({ locale: 'sw' }).expect(200);
    await api().patch('/v1/me').set(await as()).send({ phone_e164: '+1' }).expect(400);
    await api().patch('/v1/me').set(await as()).send({}).expect(400);
  });
  it('stores progress, saved items and subscriptions per user', async () => {
    await api().put(`/v1/me/progress/${ID}`).set(await as()).send({ chapters_read: 4 }).expect(204);
    await api().put(`/v1/me/saved/${ID}`).set(await as()).expect(204);
    await api().put(`/v1/me/subscriptions/${ID}`).set(await as()).expect(204);
    const mine = (await api().get('/v1/me/data').set(await as()).expect(200)).body;
    expect(mine.progress[0].chapters_read).toBe(4); expect(mine.saved).toHaveLength(1); expect(mine.subscriptions).toHaveLength(1);
    const other = (await api().get('/v1/me/data').set(await as('u2')).expect(200)).body;
    expect(other).toEqual({ progress: [], saved: [], subscriptions: [] });
    await api().delete(`/v1/me/saved/${ID}`).set(await as()).expect(204);
  });
  it('validates ids and bodies', async () => {
    await api().put('/v1/me/saved/not-a-uuid').set(await as()).expect(400);
    await api().put(`/v1/me/progress/${ID}`).set(await as()).send({ chapters_read: -1 }).expect(400);
  });
  it('permanently deletes the account', async () => {
    await api().post('/v1/me').set(await as()).send(reg).expect(201);
    await api().delete('/v1/me').set(await as()).expect(204);
    expect(repo.deleted).toEqual(['u1']);
    await api().get('/v1/me').set(await as()).expect(404);
  });
});
