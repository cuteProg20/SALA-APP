import { randomUUID } from 'node:crypto';
import { AssetInfo, EntityType, ReadingSection, Row, TABLES } from '../src/content/entities';
import { AuditEntry, DataRepository, Profile, PublishedChange, PublishItem, StaffRole, UserData } from '../src/supabase/data.repository';
import { RepoError } from '../src/common/repo-error';

/** In-memory stand-in for the database, mirroring the behaviour the real schema provides. */
export class FakeRepo extends DataRepository {
  roles = new Map<string, StaffRole>();
  rows = new Map<EntityType, Map<string, Row>>();
  sections = new Map<string, ReadingSection[]>();
  assets = new Map<string, AssetInfo>();
  published = new Map<string, PublishedChange>();
  seq = 0;
  batches: Array<{ id: string; status: string }> = [];
  auditLog: AuditEntry[] = [];
  phones = new Map<string, string>();
  profiles = new Map<string, Profile>();
  userData = new Map<string, UserData>();
  deleted: string[] = [];
  failCommit = false;
  uploads: string[] = [];

  private t(type: EntityType) { if (!this.rows.has(type)) this.rows.set(type, new Map()); return this.rows.get(type)!; }

  async fetchChanges(after: number, limit: number) { return [...this.published.values()].filter((p) => p.change_seq > after).sort((a, b) => a.change_seq - b.change_seq).slice(0, limit); }
  async maxChangeSeq() { return this.seq; }
  async staffRole(id: string) { return this.roles.get(id) ?? null; }
  async ping() { return true; }

  async listRows(type: EntityType, o: { status?: string; limit: number; offset: number }) {
    return [...this.t(type).values()].filter((r) => !o.status || r.status === o.status).slice(o.offset, o.offset + o.limit);
  }
  async getRow(type: EntityType, id: string) { return this.t(type).get(id) ?? null; }
  async insertRow(type: EntityType, fields: Record<string, unknown>, userId: string) {
    const pk = TABLES[type].pk; const id = (pk === 'day' ? fields.day : randomUUID()) as string;
    if (this.t(type).has(id)) throw new RepoError('conflict');
    const row = { ...fields, [pk]: id, status: 'draft', version: 1, updated_by: userId } as Row;
    this.t(type).set(id, row); return row;
  }
  async updateRow(type: EntityType, id: string, fields: Record<string, unknown>, userId: string) {
    const cur = this.t(type).get(id); if (!cur) throw new RepoError('notfound');
    const row = { ...cur, ...fields, version: cur.version + 1, updated_by: userId } as Row; this.t(type).set(id, row); return row;
  }
  async setStatus(type: EntityType, id: string, status: 'draft' | 'published' | 'archived') { const r = this.t(type).get(id); if (r) r.status = status; }
  async getSections(id: string) { return this.sections.get(id) ?? []; }
  async replaceSections(id: string, s: ReadingSection[]) { this.sections.set(id, s); }
  async getAssets(ids: string[]) { return new Map(ids.filter((i) => this.assets.has(i)).map((i) => [i, this.assets.get(i)!])); }
  async liveVersions(type: EntityType) {
    return new Map([...this.published.values()].filter((p) => p.entity_type === type).map((p) => [p.entity_id, { version: p.version, deleted: p.deleted }]));
  }
  async createBatch() { const id = randomUUID(); this.batches.push({ id, status: 'pending' }); return id; }
  async commitBatch(id: string, items: PublishItem[]) {
    if (this.failCommit) throw new RepoError('unknown', 'boom');
    for (const it of items) this.published.set(`${it.entity_type}:${it.entity_id}`, {
      entity_type: it.entity_type, entity_id: it.entity_id, version: it.version, payload: it.deleted ? null : it.payload, deleted: !!it.deleted, change_seq: ++this.seq });
    this.batches.find((b) => b.id === id)!.status = 'committed'; return this.seq;
  }
  async failBatch(id: string) { const b = this.batches.find((x) => x.id === id); if (b) b.status = 'failed'; }
  async createSignedUpload(path: string) { this.uploads.push(path); return { signedUrl: `https://upload.test/${path}`, token: 't', path }; }
  async insertMediaAsset(a: { kind: string; storage_path?: string | null; external_url?: string | null; mime_type: string }) {
    const id = randomUUID(); this.assets.set(id, { id, kind: a.kind, storage_path: a.storage_path ?? null, external_url: a.external_url ?? null, mime_type: a.mime_type, width: null, height: null, duration_s: null }); return { id };
  }
  async audit(e: AuditEntry) { this.auditLog.push(e); }
  async authPhone(id: string) { return this.phones.get(id) ?? null; }
  async getProfile(id: string) { return this.profiles.get(id) ?? null; }
  async createProfile(p: Omit<Profile, 'created_at'>) { const r = { ...p, created_at: new Date().toISOString() }; this.profiles.set(p.id, r); return r; }
  async updateProfile(id: string, f: Record<string, unknown>) { const r = { ...this.profiles.get(id)!, ...f } as Profile; this.profiles.set(id, r); return r; }
  async getUserData(id: string) { return this.userData.get(id) ?? { progress: [], saved: [], subscriptions: [] }; }
  async upsertProgress(id: string, item: string, n: number) { const d = await this.getUserData(id); d.progress = [...d.progress.filter((p) => p.library_item_id !== item), { library_item_id: item, chapters_read: n, updated_at: 'now' }]; this.userData.set(id, d); }
  async setSaved(id: string, media: string, saved: boolean) { const d = await this.getUserData(id); d.saved = d.saved.filter((s) => s.media_item_id !== media); if (saved) d.saved.push({ media_item_id: media, saved_at: 'now' }); this.userData.set(id, d); }
  async setSubscription(id: string, ch: string, on: boolean) { const d = await this.getUserData(id); d.subscriptions = d.subscriptions.filter((s) => s.channel_id !== ch); if (on) d.subscriptions.push({ channel_id: ch }); this.userData.set(id, d); }
  async upsertDeviceToken() { /* not asserted */ }
  async deleteAccount(id: string) { this.deleted.push(id); this.profiles.delete(id); this.userData.delete(id); }
}
