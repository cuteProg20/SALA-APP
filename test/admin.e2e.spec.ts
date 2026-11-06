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

describe('admin content API (roles, validation, publishing)', () => {
  let app: INestApplication; let repo: FakeRepo;
  const api = () => request(app.getHttpServer());
  const as = async (u: string) => ({ Authorization: `Bearer ${await tok(u)}` });

  beforeEach(async () => {
    repo = new FakeRepo();
    repo.roles.set('viewer', 'viewer'); repo.roles.set('editor', 'editor'); repo.roles.set('pub', 'publisher');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DataRepository).useValue(repo).compile();
    app = mod.createNestApplication(); app.enableVersioning({ type: VersioningType.URI }); await app.init();
  });
  afterEach(() => app.close());

  const newCategory = async (u = 'editor') => (await api().post('/v1/admin/content/category').set(await as(u))
    .send({ scope: 'home', slug: 'daily', title_en: 'Daily' }).expect(201)).body;

  it('requires login and a staff role', async () => {
    await api().get('/v1/admin/content/category').expect(401);
    await api().get('/v1/admin/content/category').set(await as('nobody')).expect(403);
    await api().get('/v1/admin/content/category').set(await as('viewer')).expect(200);
  });
  it('viewers cannot write; editors cannot publish; publishers can', async () => {
    await api().post('/v1/admin/content/category').set(await as('viewer')).send({ scope: 'home', slug: 'a', title_en: 'A' }).expect(403);
    const c = await newCategory();
    const body = { items: [{ type: 'category', id: c.id }] };
    await api().post('/v1/admin/publish').set(await as('editor')).send(body).expect(403);
    await api().post('/v1/admin/publish').set(await as('pub')).send(body).expect(201);
  });
  it('rejects unknown fields so status/version cannot be mass-assigned', async () => {
    await api().post('/v1/admin/content/category').set(await as('editor')).send({ scope: 'home', slug: 'a', title_en: 'A', status: 'published', version: 99 }).expect(400);
    const c = await newCategory();
    await api().patch(`/v1/admin/content/category/${c.id}`).set(await as('editor')).send({ status: 'published' }).expect(400);
  });
  it('validation errors never echo submitted values', async () => {
    const r = await api().post('/v1/admin/content/category').set(await as('editor')).send({ scope: 'bogus-value-123', slug: 'A B', title_en: '' }).expect(400);
    expect(JSON.stringify(r.body)).not.toContain('bogus-value-123');
  });
  it('rejects unknown types and malformed ids', async () => {
    await api().get('/v1/admin/content/nope').set(await as('viewer')).expect(404);
    await api().get('/v1/admin/content/category/not-a-uuid').set(await as('viewer')).expect(400);
  });

  it('publishing makes content visible to the sync feed; later edits stay private until republished', async () => {
    const c = await newCategory();
    const pub = await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }], note: 'first' }).expect(201);
    expect(pub.body.count).toBe(1);
    let feed = (await api().get('/v1/sync').set(await as('anyone')).expect(200)).body;
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].payload.title_en).toBe('Daily');
    expect(feed.items[0].payload).not.toHaveProperty('updated_by');
    expect(feed.items[0].payload).not.toHaveProperty('status');

    await api().patch(`/v1/admin/content/category/${c.id}`).set(await as('editor')).send({ title_en: 'Daily v2' }).expect(200);
    feed = (await api().get('/v1/sync').set(await as('anyone')).expect(200)).body;
    expect(feed.items[0].payload.title_en).toBe('Daily');            // live copy unchanged
    const list = (await api().get('/v1/admin/content/category').set(await as('viewer')).expect(200)).body;
    expect(list[0].has_unpublished_changes).toBe(true);

    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }] }).expect(201);
    feed = (await api().get('/v1/sync?cursor=1').set(await as('anyone')).expect(200)).body;
    expect(feed.items[0].payload.title_en).toBe('Daily v2');
  });

  it('publishes a batch all-or-nothing: one invalid item blocks everything', async () => {
    const good = await newCategory();
    const bad = (await api().post('/v1/admin/content/media_item').set(await as('editor')).send({ kind: 'audio', title: 'No file attached' }).expect(201)).body;
    const r = await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: good.id }, { type: 'media_item', id: bad.id }] }).expect(422);
    expect(r.body.problems[0].messages[0]).toMatch(/media_asset_id/);
    expect(repo.published.size).toBe(0);
    expect(repo.batches).toHaveLength(0);
  });
  it('marks the batch failed and publishes nothing if the commit fails', async () => {
    const c = await newCategory(); repo.failCommit = true;
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }] }).expect(500);
    expect(repo.published.size).toBe(0); expect(repo.batches[0].status).toBe('failed');
    expect((await repo.getRow('category', c.id))!.status).toBe('draft');
  });
  it('resolves media assets to public URLs and requires them to exist', async () => {
    const up = (await api().post('/v1/admin/media/upload-url').set(await as('editor')).send({ mime_type: 'audio/mpeg', bytes: 1000, license_note: 'Owned by parish' }).expect(201)).body;
    const item = (await api().post('/v1/admin/content/media_item').set(await as('editor')).send({ kind: 'audio', title: 'Rosary', media_asset_id: up.asset_id }).expect(201)).body;
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'media_item', id: item.id }] }).expect(201);
    const p = (await api().get('/v1/sync').set(await as('x'))).body.items[0].payload;
    expect(p.media.url).toMatch(/^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/published-media\/audio\/.+\.mp3$/);
    expect(p).not.toHaveProperty('media_asset_id');
    const ghost = (await api().post('/v1/admin/content/media_item').set(await as('editor')).send({ kind: 'audio', title: 'Ghost', media_asset_id: '11111111-1111-4111-8111-111111111111' }).expect(201)).body;
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'media_item', id: ghost.id }] }).expect(422);
  });
  it('daily readings need a gospel; sections are published with the reading', async () => {
    const r = (await api().post('/v1/admin/content/daily_reading').set(await as('editor')).send({ day: '2026-10-30', sections: [{ kind: 'first_reading', citation: 'Rom 8', body: 'text', position: 0 }] }).expect(201)).body;
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'daily_reading', id: r.id }] }).expect(422);
    await api().patch(`/v1/admin/content/daily_reading/${r.id}`).set(await as('editor')).send({ sections: [
      { kind: 'gospel', citation: 'Lk 13', body: 'g', position: 1 }, { kind: 'first_reading', citation: 'Rom 8', body: 'f', position: 0 }] }).expect(200);
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'daily_reading', id: r.id }] }).expect(201);
    const p = (await api().get('/v1/sync').set(await as('x'))).body.items[0].payload;
    expect(p.sections.map((s: { kind: string }) => s.kind)).toEqual(['first_reading', 'gospel']);
  });
  it('unpublish writes a tombstone; archive blocks further edits', async () => {
    const c = await newCategory();
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }] }).expect(201);
    const u = await api().post(`/v1/admin/content/category/${c.id}/unpublish`).set(await as('pub')).send({ archive: true }).expect(201);
    expect(u.body.wasLive).toBe(true);
    const feed = (await api().get('/v1/sync').set(await as('x'))).body.items;
    expect(feed[0].deleted).toBe(true); expect(feed[0].payload).toBeNull();
    await api().patch(`/v1/admin/content/category/${c.id}`).set(await as('editor')).send({ title_en: 'x' }).expect(409);
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }] }).expect(422);
  });
  it('records who did what in the audit log', async () => {
    const c = await newCategory();
    await api().post('/v1/admin/publish').set(await as('pub')).send({ items: [{ type: 'category', id: c.id }] }).expect(201);
    expect(repo.auditLog.map((a) => [a.actor_id, a.action])).toEqual([['editor', 'content.create'], ['pub', 'content.publish']]);
  });
  it('liturgical days are keyed by date and the date cannot be changed', async () => {
    await api().post('/v1/admin/content/liturgical_day').set(await as('editor')).send({ day: '2026-10-30', color: 'green' }).expect(201);
    await api().post('/v1/admin/content/liturgical_day').set(await as('editor')).send({ day: '2026-10-30', color: 'red' }).expect(409);
    await api().patch('/v1/admin/content/liturgical_day/2026-10-30').set(await as('editor')).send({ color: 'white' }).expect(200);
    await api().patch('/v1/admin/content/liturgical_day/2026-10-30').set(await as('editor')).send({ day: '2026-11-01' }).expect(400);
  });

  describe('media upload rules', () => {
    const up = async (b: object) => api().post('/v1/admin/media/upload-url').set(await as('editor')).send(b);
    it('rejects unsupported types, oversize files and a missing licence note', async () => {
      await (await up({ mime_type: 'application/x-msdownload', bytes: 10, license_note: 'mine' })).status === 400 || fail('exe accepted');
      expect((await up({ mime_type: 'image/png', bytes: 6 * 1024 * 1024, license_note: 'mine' })).status).toBe(400);
      expect((await up({ mime_type: 'image/png', bytes: 100 })).status).toBe(400);
    });
    it('derives the file extension from the MIME type, not a client filename', async () => {
      const r = await up({ mime_type: 'image/png', bytes: 100, license_note: 'own work' });
      expect(r.status).toBe(201); expect(repo.uploads[0]).toMatch(/^image\/[0-9a-f-]+\.png$/);
    });
    it('registers https links only', async () => {
      const post = async (url: string) => api().post('/v1/admin/media/external').set(await as('editor')).send({ url, kind: 'video', license_note: 'Parish channel' });
      expect((await post('http://insecure.test/v')).status).toBe(400);
      expect((await post('javascript:alert(1)')).status).toBe(400);
      expect((await post('https://youtu.be/abc')).status).toBe(201);
    });
    it('viewers cannot upload', async () => {
      await api().post('/v1/admin/media/upload-url').set(await as('viewer')).send({ mime_type: 'image/png', bytes: 1, license_note: 'abc' }).expect(403);
    });
  });
});
