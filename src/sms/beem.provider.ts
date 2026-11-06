import { Injectable } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { SmsDeliveryError, SmsProvider } from './sms.provider';

/**
 * Beem Africa SMS adapter.
 *
 * UNVERIFIED: endpoint, auth scheme and body shape below are written from general knowledge of the
 * Beem API, not from its current documentation (docs were not reachable when this was written).
 * Confirm against https://docs.beem.africa and a real test send before relying on it.
 * Everything provider-specific lives in this file.
 */
export const BEEM_SEND_URL = 'https://apisms.beem.africa/v1/send';
const TIMEOUT_MS = 8_000;

/** Beem expects the number without a leading '+', e.g. 255712345678. */
export function toBeemNumber(e164: string): string {
  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) throw new SmsDeliveryError('invalid phone number', false);
  return e164.slice(1);
}

@Injectable()
export class BeemSmsProvider extends SmsProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) { super(); }

  async send(e164: string, message: string): Promise<void> {
    const env = loadEnv();
    if (!env.BEEM_API_KEY || !env.BEEM_SECRET_KEY || !env.BEEM_SENDER_ID) {
      throw new SmsDeliveryError('SMS provider is not configured', false);
    }
    const auth = Buffer.from(`${env.BEEM_API_KEY}:${env.BEEM_SECRET_KEY}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(BEEM_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({
          source_addr: env.BEEM_SENDER_ID,
          schedule_time: '',
          encoding: 0,
          message,
          recipients: [{ recipient_id: 1, dest_addr: toBeemNumber(e164) }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SmsDeliveryError('SMS provider unreachable', true);
    }
    // Never log the message (contains the code) or the number.
    if (res.status === 401 || res.status === 403) throw new SmsDeliveryError('SMS provider rejected credentials', false);
    if (!res.ok) throw new SmsDeliveryError(`SMS provider error ${res.status}`, res.status >= 500 || res.status === 429);
  }
}
