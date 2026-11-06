import { z } from 'zod';

export const ENTITY_TYPES = [
  'category', 'library_item', 'channel', 'media_item', 'collection', 'liturgical_day', 'daily_reading', 'reflection',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const isEntityType = (v: string): v is EntityType => (ENTITY_TYPES as readonly string[]).includes(v);

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const locale = z.enum(['en', 'sw']);

const sectionSchema = z.object({
  kind: z.enum(['first_reading', 'second_reading', 'responsorial_psalm', 'gospel_acclamation', 'gospel']),
  citation: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(60_000),
  position: z.number().int().min(0).max(20),
}).strict();
export type ReadingSection = z.infer<typeof sectionSchema>;

/** Writable fields per type. `.strict()` rejects unknown keys (no mass assignment of status/version/etc.). */
export const WRITE_SCHEMAS = {
  category: z.object({
    scope: z.enum(['library_explorer', 'library_prayers', 'audio', 'video', 'home']),
    slug: z.string().regex(/^[a-z0-9-]{1,60}$/), title_en: z.string().trim().min(1).max(120),
    title_sw: optText(120), sort_order: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  library_item: z.object({
    tab: z.enum(['explorer', 'prayers']), category_id: uuid.nullable().optional(),
    title: z.string().trim().min(1).max(200), author: optText(200), description: optText(5000),
    cover_asset_id: uuid.nullable().optional(), file_asset_id: uuid.nullable().optional(),
    chapter_count: z.number().int().min(0).max(10000).nullable().optional(), sort_order: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  channel: z.object({ name: z.string().trim().min(1).max(120), avatar_asset_id: uuid.nullable().optional() }).strict(),
  media_item: z.object({
    kind: z.enum(['video', 'short', 'audio']), channel_id: uuid.nullable().optional(), category_id: uuid.nullable().optional(),
    title: z.string().trim().min(1).max(200), description: optText(5000), speaker: optText(120),
    duration_s: z.number().int().min(0).max(86400).nullable().optional(),
    media_asset_id: uuid.nullable().optional(), thumbnail_asset_id: uuid.nullable().optional(),
    published_on: z.string().datetime().nullable().optional(), is_recommended: z.boolean().optional(),
  }).strict(),
  collection: z.object({
    title: z.string().trim().min(1).max(200), subtitle: optText(200), cover_asset_id: uuid.nullable().optional(),
    sort_order: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  liturgical_day: z.object({
    day, season: optText(80), celebration: optText(300), rank: optText(80),
    color: z.enum(['green', 'purple', 'white', 'red', 'rose', 'gold']),
  }).strict(),
  daily_reading: z.object({
    day, locale: locale.optional(), memorial: optText(500), summary: optText(5000),
    sections: z.array(sectionSchema).max(10).optional(),
  }).strict(),
  reflection: z.object({
    day, locale: locale.optional(), title: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(100_000),
    reading_id: uuid.nullable().optional(),
  }).strict(),
} as const satisfies Record<EntityType, z.ZodTypeAny>;

export const TABLES: Record<EntityType, { table: string; pk: 'id' | 'day'; assetFields: string[] }> = {
  category: { table: 'categories', pk: 'id', assetFields: [] },
  library_item: { table: 'library_items', pk: 'id', assetFields: ['cover_asset_id', 'file_asset_id'] },
  channel: { table: 'channels', pk: 'id', assetFields: ['avatar_asset_id'] },
  media_item: { table: 'media_items', pk: 'id', assetFields: ['media_asset_id', 'thumbnail_asset_id'] },
  collection: { table: 'collections', pk: 'id', assetFields: ['cover_asset_id'] },
  liturgical_day: { table: 'liturgical_days', pk: 'day', assetFields: [] },
  daily_reading: { table: 'daily_readings', pk: 'id', assetFields: [] },
  reflection: { table: 'reflections', pk: 'id', assetFields: [] },
};

export type Row = Record<string, unknown> & { version: number; status: 'draft' | 'published' | 'archived' };

export interface AssetInfo { id: string; kind: string; storage_path: string | null; external_url: string | null; mime_type: string; width: number | null; height: number | null; duration_s: number | null }

/** Extra conditions that must hold before something goes live. Returns human-readable problems. */
export function publishProblems(type: EntityType, row: Row, sections: ReadingSection[] = []): string[] {
  const p: string[] = [];
  const has = (k: string) => row[k] !== null && row[k] !== undefined && row[k] !== '';
  if (type === 'media_item' && !has('media_asset_id')) p.push('media_asset_id is required to publish a media item');
  if (type === 'library_item' && !has('cover_asset_id')) p.push('cover_asset_id is required to publish a library item');
  if (type === 'daily_reading') {
    if (!sections.some((s) => s.kind === 'gospel')) p.push('a gospel section is required');
    if (new Set(sections.map((s) => s.kind)).size !== sections.length) p.push('each section kind may appear only once');
  }
  if (type === 'reflection' && String(row.body ?? '').length < 20) p.push('reflection body is too short');
  return p;
}

const STRIP = new Set(['updated_by', 'created_by']);
export const publicUrl = (supabaseUrl: string, path: string) => `${supabaseUrl}/storage/v1/object/public/published-media/${path}`;

/** The immutable snapshot the mobile app receives. Asset ids are resolved to URLs; internal fields are dropped. */
export function buildPayload(type: EntityType, row: Row, assets: Map<string, AssetInfo>, supabaseUrl: string, sections: ReadingSection[] = []) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!STRIP.has(k) && k !== 'status') out[k] = v;
  for (const f of TABLES[type].assetFields) {
    const id = row[f] as string | null | undefined;
    const base = f.replace(/_asset_id$/, '');
    delete out[f];
    const a = id ? assets.get(id) : undefined;
    out[base] = a
      ? { url: a.external_url ?? publicUrl(supabaseUrl, a.storage_path as string), mime: a.mime_type, width: a.width, height: a.height, duration_s: a.duration_s }
      : null;
  }
  if (type === 'daily_reading') out.sections = [...sections].sort((x, y) => x.position - y.position);
  return out;
}
