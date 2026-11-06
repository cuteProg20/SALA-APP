import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_S = 300;

/**
 * Verifies a Standard Webhooks signature (the scheme Supabase Auth hooks use).
 * UNVERIFIED against a live Supabase project: header names and secret format follow the
 * Standard Webhooks spec ("whsec_<base64>" secret, signed content "id.timestamp.body").
 */
export function verifyWebhook(opts: {
  secret: string; id?: string; timestamp?: string; signature?: string; rawBody: Buffer | string; nowMs?: number;
}): boolean {
  const { id, timestamp, signature, rawBody } = opts;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs((opts.nowMs ?? Date.now()) / 1000 - ts) > TOLERANCE_S) return false;

  // Accept "v1,whsec_xxx", "whsec_xxx" or a bare base64 secret.
  const raw = opts.secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  const key = Buffer.from(raw, 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody.toString()}`).digest();

  return signature.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
