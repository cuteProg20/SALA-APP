import { loadEnv } from './env';

const ok = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key-value' };

describe('loadEnv', () => {
  it('applies defaults', () => {
    const e = loadEnv(ok);
    expect(e.PORT).toBe(3000);
    expect(e.NODE_ENV).toBe('development');
  });
  it('rejects a missing service key', () => {
    expect(() => loadEnv({ SUPABASE_URL: ok.SUPABASE_URL })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
  it('rejects a malformed url', () => {
    expect(() => loadEnv({ ...ok, SUPABASE_URL: 'nope' })).toThrow(/SUPABASE_URL/);
  });
  it('never echoes secret values in the error', () => {
    try { loadEnv({ SUPABASE_URL: 'bad', SUPABASE_SERVICE_ROLE_KEY: 'super-secret-xyz' }); fail('should throw'); }
    catch (e) { expect((e as Error).message).not.toContain('super-secret-xyz'); }
  });
});

describe('loadEnv with an unfilled template', () => {
  it('treats empty strings as unset (optional) and still requires the mandatory ones', () => {
    const e = loadEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', BEEM_API_KEY: '', SUPABASE_JWT_SECRET: '' });
    expect(e.BEEM_API_KEY).toBeUndefined();
    expect(e.SUPABASE_JWT_SECRET).toBeUndefined();
    expect(() => loadEnv({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(/SUPABASE_URL/);
  });
});
