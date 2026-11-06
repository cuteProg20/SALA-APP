import { BEEM_SEND_URL, BeemSmsProvider, toBeemNumber } from './beem.provider';
import { SmsDeliveryError } from './sms.provider';

const setEnv = (extra: Record<string, string | undefined> = {}) => {
  Object.assign(process.env, { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', BEEM_API_KEY: 'ak', BEEM_SECRET_KEY: 'sk', BEEM_SENDER_ID: 'SALA' }, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
};
const fake = (status: number) => jest.fn(async () => ({ ok: status >= 200 && status < 300, status }) as Response);

describe('BeemSmsProvider', () => {
  beforeEach(() => setEnv());

  it('strips the + for Beem and validates E.164', () => {
    expect(toBeemNumber('+255712345678')).toBe('255712345678');
    expect(() => toBeemNumber('0712345678')).toThrow(SmsDeliveryError);
  });
  it('sends basic-auth JSON to the Beem endpoint', async () => {
    const f = fake(200);
    await new BeemSmsProvider(f as never).send('+255712345678', 'hello');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BEEM_SEND_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('ak:sk').toString('base64')}`);
    const body = JSON.parse(init.body as string);
    expect(body.recipients).toEqual([{ recipient_id: 1, dest_addr: '255712345678' }]);
    expect(body.source_addr).toBe('SALA'); expect(body.message).toBe('hello');
  });
  it('fails clearly (non-retryable) when not configured', async () => {
    setEnv({ BEEM_API_KEY: undefined });
    await expect(new BeemSmsProvider(fake(200) as never).send('+255712345678', 'x')).rejects.toMatchObject({ retryable: false });
  });
  it.each([[401, false], [403, false], [400, false], [429, true], [500, true], [503, true]])('status %i -> retryable=%s', async (status, retryable) => {
    await expect(new BeemSmsProvider(fake(status) as never).send('+255712345678', 'x')).rejects.toMatchObject({ retryable });
  });
  it('treats network failure as retryable', async () => {
    const f = jest.fn(async () => { throw new Error('boom'); });
    await expect(new BeemSmsProvider(f as never).send('+255712345678', 'x')).rejects.toMatchObject({ retryable: true });
  });
  it('error messages never contain the secret or the number', async () => {
    try { await new BeemSmsProvider(fake(401) as never).send('+255712345678', 'code 424242'); fail('x'); }
    catch (e) { const m = (e as Error).message; expect(m).not.toMatch(/sk|255712345678|424242/); }
  });
});
