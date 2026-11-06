import { createHmac } from 'node:crypto';
import { verifyWebhook } from './webhook-signature';

const keyBytes = Buffer.from('0123456789abcdef0123456789abcdef');
const secret = `v1,whsec_${keyBytes.toString('base64')}`;
const body = '{"user":{"phone":"+255700000001"},"sms":{"otp":"123456"}}';
const now = 1_800_000_000_000;
const ts = String(now / 1000);
const sig = (id: string, t: string, b: string, k = keyBytes) => `v1,${createHmac('sha256', k).update(`${id}.${t}.${b}`).digest('base64')}`;
const base = { secret, id: 'msg_1', timestamp: ts, rawBody: body, nowMs: now };

describe('verifyWebhook', () => {
  it('accepts a correctly signed request', () => expect(verifyWebhook({ ...base, signature: sig('msg_1', ts, body) })).toBe(true));
  it('accepts when one of several signatures matches', () =>
    expect(verifyWebhook({ ...base, signature: `v1,AAAA ${sig('msg_1', ts, body)}` })).toBe(true));
  it('rejects a tampered body', () => expect(verifyWebhook({ ...base, rawBody: body.replace('123456', '999999'), signature: sig('msg_1', ts, body) })).toBe(false));
  it('rejects a wrong key', () => expect(verifyWebhook({ ...base, signature: sig('msg_1', ts, body, Buffer.from('another-key-another-key-another!!')) })).toBe(false));
  it('rejects a replayed old timestamp', () => {
    const old = String(now / 1000 - 3600);
    expect(verifyWebhook({ ...base, timestamp: old, signature: sig('msg_1', old, body) })).toBe(false);
  });
  it('rejects missing headers', () => expect(verifyWebhook({ ...base, signature: undefined })).toBe(false));
  it('rejects an empty secret', () => expect(verifyWebhook({ ...base, secret: '', signature: sig('msg_1', ts, body) })).toBe(false));
  it('rejects non-v1 signature versions', () => expect(verifyWebhook({ ...base, signature: sig('msg_1', ts, body).replace('v1,', 'v2,') })).toBe(false));
});
