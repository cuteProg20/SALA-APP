import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sb = resolve(__dirname, '../../../supabase');

describe('database schema (real migration on in-memory PostgreSQL)', () => {
  let pg: PGlite; let staff: string; let user: string; let other: string;
  const as = async (uid: string | null, sql: string, params: unknown[] = []) => {
    await pg.exec(`reset role; select set_config('app.uid', '${uid ?? ''}', false); set role authenticated;`);
    try { return await pg.query(sql, params); } finally { await pg.exec('reset role'); }
  };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync(resolve(sb, 'ci/stub_supabase.sql'), 'utf8'));
    await pg.exec(readFileSync(resolve(sb, 'migrations/0001_initial_schema.sql'), 'utf8'));
    await pg.exec('grant usage on schema auth, public to authenticated; grant select, insert, update, delete on all tables in schema public to authenticated;');
    const id = async () => (await pg.query<{ id: string }>('insert into auth.users default values returning id')).rows[0].id;
    [staff, user, other] = [await id(), await id(), await id()];
    await pg.query(`insert into staff_members(user_id, role, display_name) values ($1,'viewer','V')`, [staff]);
    await pg.query(`insert into app_profiles(id, first_name, last_name, phone_e164) values ($1,'A','B','+255700000001'), ($2,'C','D','+255700000002')`, [user, other]);
    await pg.query(`insert into reading_progress(user_id, library_item_id) select $1, null where false`, [user]);
    await pg.query(`insert into categories(scope, slug, title_en) values ('home','x','X')`);
    const b = (await pg.query<{ id: string }>('insert into publish_batches(created_by) values ($1) returning id', [staff])).rows[0].id;
    await pg.query(`select commit_publish_batch($1, $2::jsonb)`, [b, JSON.stringify([{ entity_type: 'category', entity_id: 'x', version: 1, payload: { t: 'X' }, deleted: false }])]);
  });
  afterAll(() => pg.close());

  it('assigns increasing change_seq and writes tombstones', async () => {
    const b = (await pg.query<{ id: string }>('insert into publish_batches(created_by) values ($1) returning id', [staff])).rows[0].id;
    await pg.query(`select commit_publish_batch($1, $2::jsonb)`, [b, JSON.stringify([{ entity_type: 'category', entity_id: 'x', version: 2, deleted: true }])]);
    const r = (await pg.query<{ deleted: boolean; payload: unknown; change_seq: number }>(`select deleted, payload, change_seq from published_entities where entity_id='x'`)).rows[0];
    expect(r.deleted).toBe(true); expect(r.payload).toBeNull(); expect(Number(r.change_seq)).toBeGreaterThan(1);
  });
  it('rejects invalid phone numbers', async () => {
    await expect(pg.query(`insert into app_profiles(id, first_name, last_name, phone_e164) values ($1,'x','y','0712')`, [staff])).rejects.toThrow();
  });
  it('RLS: a user sees only their own profile', async () => {
    const r = await as(user, 'select id from app_profiles');
    expect(r.rows).toEqual([{ id: user }]);
  });
  it('RLS: an unauthenticated caller sees no profiles', async () => {
    expect((await as(null, 'select id from app_profiles')).rows).toEqual([]);
  });
  it('RLS: a user cannot update someone else\'s profile', async () => {
    const r = await as(user, `update app_profiles set first_name='hacked' where id=$1 returning id`, [other]);
    expect(r.rows).toEqual([]);
  });
  it('RLS: a non-staff user cannot read draft content', async () => {
    expect((await as(user, 'select id from categories')).rows).toEqual([]);
  });
  it('RLS: a viewer can read but not write drafts', async () => {
    expect((await as(staff, 'select id from categories')).rows.length).toBe(1);
    await expect(as(staff, `insert into categories(scope, slug, title_en) values ('home','y','Y')`)).rejects.toThrow();
  });
  it('RLS: published content is readable by signed-in users but not writable', async () => {
    expect((await as(user, 'select entity_id from published_entities')).rows.length).toBeGreaterThan(0);
    await expect(as(user, `delete from published_entities`)).resolves.toBeDefined(); // no policy -> 0 rows affected
    expect((await pg.query('select 1 from published_entities')).rows.length).toBeGreaterThan(0);
  });
  it('commit_publish_batch cannot be called by signed-in users', async () => {
    await expect(as(user, `select commit_publish_batch(gen_random_uuid(), '[]'::jsonb)`)).rejects.toThrow();
  });
  it('audit_logs are not readable by non-admins', async () => {
    expect((await as(user, 'select id from audit_logs')).rows).toEqual([]);
  });
});
