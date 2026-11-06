import type { AssetInfo, EntityType, ReadingSection, Row } from '../content/entities';

export interface PublishedChange {
  entity_type: string; entity_id: string; version: number; payload: unknown | null; deleted: boolean; change_seq: number;
}
export type StaffRole = 'super_admin' | 'editor' | 'publisher' | 'viewer';

export interface Profile {
  id: string; first_name: string; middle_name: string | null; last_name: string; phone_e164: string;
  age: number | null; locale: 'en' | 'sw'; created_at: string;
}
export interface UserData {
  progress: Array<{ library_item_id: string; chapters_read: number; updated_at: string }>;
  saved: Array<{ media_item_id: string; saved_at: string }>;
  subscriptions: Array<{ channel_id: string }>;
}
export interface AuditEntry {
  actor_id: string; action: string; entity_type?: string; entity_id?: string; before_data?: unknown; after_data?: unknown;
}
export interface PublishItem { entity_type: string; entity_id: string; version: number; payload?: unknown; deleted?: boolean }

/** Port used by services. SupabaseRepository is the only implementation that touches the network. */
export abstract class DataRepository {
  // sync (mobile)
  abstract fetchChanges(afterSeq: number, limit: number): Promise<PublishedChange[]>;
  abstract maxChangeSeq(): Promise<number>;
  // auth / health
  abstract staffRole(userId: string): Promise<StaffRole | null>;
  abstract ping(): Promise<boolean>;
  // content authoring (staff)
  abstract listRows(type: EntityType, opts: { status?: string; limit: number; offset: number }): Promise<Row[]>;
  abstract getRow(type: EntityType, id: string): Promise<Row | null>;
  abstract insertRow(type: EntityType, fields: Record<string, unknown>, userId: string): Promise<Row>;
  abstract updateRow(type: EntityType, id: string, fields: Record<string, unknown>, userId: string): Promise<Row>;
  abstract setStatus(type: EntityType, id: string, status: 'draft' | 'published' | 'archived', userId: string): Promise<void>;
  abstract getSections(readingId: string): Promise<ReadingSection[]>;
  abstract replaceSections(readingId: string, sections: ReadingSection[]): Promise<void>;
  abstract getAssets(ids: string[]): Promise<Map<string, AssetInfo>>;
  abstract liveVersions(type: EntityType): Promise<Map<string, { version: number; deleted: boolean }>>;
  // publishing
  abstract createBatch(userId: string, note: string | null): Promise<string>;
  abstract commitBatch(batchId: string, items: PublishItem[]): Promise<number>;
  abstract failBatch(batchId: string): Promise<void>;
  // media
  abstract createSignedUpload(path: string): Promise<{ signedUrl: string; token: string; path: string }>;
  abstract insertMediaAsset(a: { kind: string; storage_path?: string | null; external_url?: string | null; mime_type: string; bytes?: number | null; license_note: string; created_by: string }): Promise<{ id: string }>;
  // audit
  abstract audit(e: AuditEntry): Promise<void>;
  // end users
  abstract authPhone(userId: string): Promise<string | null>;
  abstract getProfile(userId: string): Promise<Profile | null>;
  abstract createProfile(p: Omit<Profile, 'created_at'>): Promise<Profile>;
  abstract updateProfile(userId: string, fields: Partial<Pick<Profile, 'first_name' | 'middle_name' | 'last_name' | 'age' | 'locale'>>): Promise<Profile>;
  abstract getUserData(userId: string): Promise<UserData>;
  abstract upsertProgress(userId: string, itemId: string, chaptersRead: number): Promise<void>;
  abstract setSaved(userId: string, mediaId: string, saved: boolean): Promise<void>;
  abstract setSubscription(userId: string, channelId: string, on: boolean): Promise<void>;
  abstract upsertDeviceToken(userId: string, platform: 'android' | 'ios', token: string): Promise<void>;
  abstract deleteAccount(userId: string): Promise<void>;
}
