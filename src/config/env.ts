import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  // SMS (Beem Africa) and the Supabase Send-SMS hook secret. Optional so the API can boot before they exist.
  BEEM_API_KEY: z.string().optional(),
  BEEM_SECRET_KEY: z.string().optional(),
  BEEM_SENDER_ID: z.string().max(11).optional(),
  SUPABASE_SMS_HOOK_SECRET: z.string().optional(),
});
export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // A template line like `BEEM_API_KEY=` yields an empty string; treat that as "not set".
  source = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Report variable names only; never echo values (they may be secrets).
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  return parsed.data;
}
