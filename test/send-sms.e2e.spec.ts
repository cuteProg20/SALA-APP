process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
const keyBytes = Buffer.from('0123456789abcdef0123456789abcdef');
process.env.SUPABASE_SMS_HOOK_SECRET = `v1,whsec_${keyBytes.toString('base64')}`;

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { DataRepository } from '../src/supabase/data.repository';
import { SmsDeliveryError, SmsProvider } from '../src/sms/sms.provider';

describe('POST /v1/hooks/send-sms', () => {
  let app: INestApplication;
  const sent: Array<{ to: string; msg: string }> = [];
  let failWith: Error | null = null;
  const sms = { send: async (to: string, msg: string) => { if (failWith) throw failWith; sent.push({ to, msg }); } };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataRepository).useValue({})
      .overrideProvider(SmsProvider).useValue(sms).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => { sent.length = 0; failWith = null; });

  const body = JSON.stringify({ user: { phone: '255712345678' }, sms: { otp: '123456' } });
  const post = (b = body, over: { id?: string; ts?: string; sig?: string } = {}) => {
    const id = over.id ?? 'msg_1'; const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
    const sig = over.sig ?? `v1,${createHmac('sha256', keyBytes).update(`${id}.${ts}.${b}`).digest('base64')}`;
    return request(app.getHttpServer()).post('/v1/hooks/send-sms').set('Content-Type', 'application/json')
      .set('webhook-id', id).set('webhook-timestamp', ts).set('webhook-signature', sig).send(b);
  };

  it('delivers the code to the + prefixed number for a signed request', async () => {
    await post().expect(200, {});
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+255712345678');
    expect(sent[0].msg).toContain('123456');
  });
  it('rejects an unsigned request and sends nothing', async () => {
    await request(app.getHttpServer()).post('/v1/hooks/send-sms').set('Content-Type', 'application/json').send(body).expect(401);
    expect(sent).toHaveLength(0);
  });
  it('rejects a bad signature', async () => { await post(body, { sig: 'v1,AAAA' }).expect(401); expect(sent).toHaveLength(0); });
  it('rejects a body that does not match the signature', async () => {
    const tampered = JSON.stringify({ user: { phone: '255799999999' }, sms: { otp: '123456' } });
    const id = 'msg_2'; const ts = String(Math.floor(Date.now() / 1000));
    const sigOfOriginal = `v1,${createHmac('sha256', keyBytes).update(`${id}.${ts}.${body}`).digest('base64')}`;
    await post(tampered, { id, ts, sig: sigOfOriginal }).expect(401);
    expect(sent).toHaveLength(0);
  });
  it('rejects a malformed payload (signed but wrong shape)', async () => { await post('{"user":{},"sms":{"otp":"abc"}}').expect(400); });
  it('returns 503 when the provider fails, without leaking details', async () => {
    failWith = new SmsDeliveryError('provider said secret-detail', true);
    const r = await post().expect(503);
    expect(JSON.stringify(r.body)).not.toContain('secret-detail');
  });
});
