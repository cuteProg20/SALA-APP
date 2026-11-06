import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  AuditEntry, DataRepository, Profile, PublishedChange, PublishItem, StaffRole, UserData,
} from './data.repository';
import { loadEnv } from '../config/env';
import { AssetInfo, EntityType, ReadingSection, Row, TABLES } from '../content/entities';
import { RepoError } from '../common/repo-error';

type PgErr = { code?: string; message?: string } | null;
function fail(error: PgErr, what: string): never {
  const c = error?.code;
  if (c === '23505') throw new RepoError('conflict', what);
  if (c === '23503' || c === '23514' || c === '22P02' || c === '22007' || c === '23502') throw new RepoError('invalid', what);
  if (c === 'PGRST116') throw new RepoError('notfound', what);
  throw new RepoError('unknown', `${what}: ${c ?? 'no-code'}`); // code only; never the message (may echo data)
}

@Injectable()
export class SupabaseRepository extends DataRepository {
  private readonly db: SupabaseClient;
  constructor() {
    super();
    const env = loadEnv();
    this.db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  // ── sync ──
  async fetchChanges(afterSeq: number, limit: number): Promise<PublishedChange[]> {
    const { data, error } = await this.db.from('published_entities')
      .select('entity_type, entity_id, version, payload, deleted, change_seq')
      .gt('change_seq', afterSeq).order('change_seq', { ascending: true }).limit(limit);
    if (error) fail(error, 'fetchChanges');
    return (data ?? []) as PublishedChange[];
  }
  async maxChangeSeq(): Promise<number> {
    const { data, error } = await this.db.from('published_entities').select('change_seq').order('change_seq', { ascending: false }).limit(1);
    if (error) fail(error, 'maxChangeSeq');
    return Number(data?.[0]?.change_seq ?? 0);
  }

  // ── auth / health ──
  async staffRole(userId: string): Promise<StaffRole | null> {
    const { data, error } = await this.db.from('staff_members').select('role, disabled').eq('user_id', userId).maybeSingle();
    if (error) fail(error, 'staffRole');
    return data && !data.disabled ? (data.role as StaffRole) : null;
  }
  async ping(): Promise<boolean> {
    const { error } = await this.db.from('publish_batches').select('id').limit(1);
    return !error;
  }

  // ── content ──
  async listRows(type: EntityType, o: { status?: string; limit: number; offset: number }): Promise<Row[]> {
    const t = TABLES[type];
    let q = this.db.from(t.table).select('*').order('updated_at', { ascending: false }).range(o.offset, o.offset + o.limit - 1);
    if (o.status) q = q.eq('status', o.status);
    const { data, error } = await q;
    if (error) fail(error, 'listRows');
    return (data ?? []) as Row[];
  }
  async getRow(type: EntityType, id: string): Promise<Row | null> {
    const t = TABLES[type];
    const { data, error } = await this.db.from(t.table).select('*').eq(t.pk, id).maybeSingle();
    if (error) fail(error, 'getRow');
    return (data as Row | null) ?? null;
  }
  async insertRow(type: EntityType, fields: Record<string, unknown>, userId: string): Promise<Row> {
    const { data, error } = await this.db.from(TABLES[type].table)
      .insert({ ...fields, status: 'draft', version: 1, updated_by: userId }).select('*').single();
    if (error) fail(error, 'insertRow');
    return data as Row;
  }
  async updateRow(type: EntityType, id: string, fields: Record<string, unknown>, userId: string): Promise<Row> {
    const t = TABLES[type];
    const cur = await this.getRow(type, id);
    if (!cur) throw new RepoError('notfound');
    // Optimistic lock: only succeeds if nobody else changed the row since we read it.
    const { data, error } = await this.db.from(t.table)
      .update({ ...fields, version: cur.version + 1, updated_by: userId, updated_at: new Date().toISOString() })
      .eq(t.pk, id).eq('version', cur.version).select('*');
    if (error) fail(error, 'updateRow');
    if (!data?.length) throw new RepoError('conflict', 'stale version');
    return data[0] as Row;
  }
  async setStatus(type: EntityType, id: string, status: 'draft' | 'published' | 'archived', userId: string): Promise<void> {
    const t = TABLES[type];
    const { error } = await this.db.from(t.table).update({ status, updated_by: userId }).eq(t.pk, id);
    if (error) fail(error, 'setStatus');
  }
  async getSections(readingId: string): Promise<ReadingSection[]> {
    const { data, error } = await this.db.from('reading_sections').select('kind, citation, body, position').eq('reading_id', readingId).order('position');
    if (error) fail(error, 'getSections');
    return (data ?? []) as ReadingSection[];
  }
  async replaceSections(readingId: string, sections: ReadingSection[]): Promise<void> {
    const del = await this.db.from('reading_sections').delete().eq('reading_id', readingId);
    if (del.error) fail(del.error, 'replaceSections.delete');
    if (!sections.length) return;
    const ins = await this.db.from('reading_sections').insert(sections.map((s) => ({ ...s, reading_id: readingId })));
    if (ins.error) fail(ins.error, 'replaceSections.insert');
  }
  async getAssets(ids: string[]): Promise<Map<string, AssetInfo>> {
    const out = new Map<string, AssetInfo>();
    if (!ids.length) return out;
    const { data, error } = await this.db.from('media_assets').select('id, kind, storage_path, external_url, mime_type, width, height, duration_s').in('id', ids);
    if (error) fail(error, 'getAssets');
    for (const a of (data ?? []) as AssetInfo[]) out.set(a.id, a);
    return out;
  }
  async liveVersions(type: EntityType): Promise<Map<string, { version: number; deleted: boolean }>> {
    const { data, error } = await this.db.from('published_entities').select('entity_id, version, deleted').eq('entity_type', type);
    if (error) fail(error, 'liveVersions');
    return new Map((data ?? []).map((r: { entity_id: string; version: number; deleted: boolean }) => [r.entity_id, { version: r.version, deleted: r.deleted }]));
  }

  // ── publishing ──
  async createBatch(userId: string, note: string | null): Promise<string> {
    const { data, error } = await this.db.from('publish_batches').insert({ created_by: userId, note }).select('id').single();
    if (error) fail(error, 'createBatch');
    return data!.id as string;
  }
  async commitBatch(batchId: string, items: PublishItem[]): Promise<number> {
    const { data, error } = await this.db.rpc('commit_publish_batch', { p_batch: batchId, p_items: items });
    if (error) fail(error, 'commitBatch');
    return Number(data);
  }
  async failBatch(batchId: string): Promise<void> {
    await this.db.from('publish_batches').update({ status: 'failed' }).eq('id', batchId);
  }

  // ── media ──
  async createSignedUpload(path: string) {
    const { data, error } = await this.db.storage.from('published-media').createSignedUploadUrl(path);
    if (error || !data) throw new RepoError('unknown', 'createSignedUpload');
    return { signedUrl: data.signedUrl, token: data.token, path: data.path };
  }
  async insertMediaAsset(a: { kind: string; storage_path?: string | null; external_url?: string | null; mime_type: string; bytes?: number | null; license_note: string; created_by: string }) {
    const { data, error } = await this.db.from('media_assets').insert(a).select('id').single();
    if (error) fail(error, 'insertMediaAsset');
    return { id: data!.id as string };
  }

  // ── audit ──
  async audit(e: AuditEntry): Promise<void> {
    const { error } = await this.db.from('audit_logs').insert(e);
    if (error) fail(error, 'audit');
  }

  // ── end users ──
  async authPhone(userId: string): Promise<string | null> {
    const { data, error } = await this.db.auth.admin.getUserById(userId);
    if (error || !data?.user) return null;
    const p = data.user.phone;
    return p ? (p.startsWith('+') ? p : `+${p}`) : null;
  }
  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.db.from('app_profiles').select('*').eq('id', userId).is('deleted_at', null).maybeSingle();
    if (error) fail(error, 'getProfile');
    return (data as Profile | null) ?? null;
  }
  async createProfile(p: Omit<Profile, 'created_at'>): Promise<Profile> {
    const { data, error } = await this.db.from('app_profiles').insert(p).select('*').single();
    if (error) fail(error, 'createProfile');
    return data as Profile;
  }
  async updateProfile(userId: string, fields: Record<string, unknown>): Promise<Profile> {
    const { data, error } = await this.db.from('app_profiles').update(fields).eq('id', userId).select('*').single();
    if (error) fail(error, 'updateProfile');
    return data as Profile;
  }
  async getUserData(userId: string): Promise<UserData> {
    const [p, s, c] = await Promise.all([
      this.db.from('reading_progress').select('library_item_id, chapters_read, updated_at').eq('user_id', userId),
      this.db.from('saved_items').select('media_item_id, saved_at').eq('user_id', userId).is('removed_at', null),
      this.db.from('channel_subscriptions').select('channel_id').eq('user_id', userId),
    ]);
    for (const r of [p, s, c]) if (r.error) fail(r.error, 'getUserData');
    return { progress: p.data ?? [], saved: s.data ?? [], subscriptions: c.data ?? [] } as UserData;
  }
  async upsertProgress(userId: string, itemId: string, chaptersRead: number): Promise<void> {
    const { error } = await this.db.from('reading_progress')
      .upsert({ user_id: userId, library_item_id: itemId, chapters_read: chaptersRead, updated_at: new Date().toISOString() });
    if (error) fail(error, 'upsertProgress');
  }
  async setSaved(userId: string, mediaId: string, saved: boolean): Promise<void> {
    const row: Record<string, unknown> = saved ? { user_id: userId, media_item_id: mediaId, saved_at: new Date().toISOString(), removed_at: null }
                      : { user_id: userId, media_item_id: mediaId, removed_at: new Date().toISOString() };
    const { error } = await this.db.from('saved_items').upsert(row);
    if (error) fail(error, 'setSaved');
  }
  async setSubscription(userId: string, channelId: string, on: boolean): Promise<void> {
    const { error } = on
      ? await this.db.from('channel_subscriptions').upsert({ user_id: userId, channel_id: channelId })
      : await this.db.from('channel_subscriptions').delete().eq('user_id', userId).eq('channel_id', channelId);
    if (error) fail(error, 'setSubscription');
  }
  async upsertDeviceToken(userId: string, platform: 'android' | 'ios', token: string): Promise<void> {
    const { error } = await this.db.from('device_tokens').upsert({ user_id: userId, platform, token, last_seen: new Date().toISOString() }, { onConflict: 'token' });
    if (error) fail(error, 'upsertDeviceToken');
  }
  async deleteAccount(userId: string): Promise<void> {
    const req = await this.db.from('deletion_requests').insert({ user_id: userId }).select('id').single();
    if (req.error) fail(req.error, 'deletion.request');
    // Deleting the auth user cascades to the profile, progress, saved items, subscriptions and device tokens.
    const del = await this.db.auth.admin.deleteUser(userId);
    if (del.error) throw new RepoError('unknown', 'deleteUser');
    await this.db.from('deletion_requests').update({ completed_at: new Date().toISOString() }).eq('id', req.data.id);
  }
}
