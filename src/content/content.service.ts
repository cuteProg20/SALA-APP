import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DataRepository } from '../supabase/data.repository';
import { loadEnv } from '../config/env';
import { buildPayload, EntityType, publishProblems, ReadingSection, Row, TABLES, WRITE_SCHEMAS } from './entities';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PUBLISH_ITEMS = 100;

export function assertValidId(type: EntityType, id: string) {
  const ok = TABLES[type].pk === 'day' ? DAY.test(id) : UUID.test(id);
  if (!ok) throw new BadRequestException({ code: 'invalid_id' });
}

function issues(e: z.ZodError) {
  // Paths and messages only. Never echo submitted values back.
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

@Injectable()
export class ContentService {
  private readonly log = new Logger(ContentService.name);
  constructor(private readonly repo: DataRepository) {}

  private parse(type: EntityType, body: unknown, partial: boolean) {
    let schema: z.ZodTypeAny = WRITE_SCHEMAS[type];
    if (partial) schema = type === 'liturgical_day' ? (WRITE_SCHEMAS.liturgical_day.omit({ day: true }).partial()) : (schema as z.ZodObject).partial();
    const r = schema.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'validation', issues: issues(r.error) });
    return r.data as Record<string, unknown>;
  }

  async list(type: EntityType, q: { status?: string; limit: number; offset: number }) {
    const [rows, live] = await Promise.all([this.repo.listRows(type, q), this.repo.liveVersions(type)]);
    const pk = TABLES[type].pk;
    return rows.map((r) => {
      const l = live.get(String(r[pk]));
      const liveVersion = l && !l.deleted ? l.version : null;
      return { ...r, live_version: liveVersion, has_unpublished_changes: liveVersion !== null && r.version > liveVersion };
    });
  }

  async get(type: EntityType, id: string) {
    assertValidId(type, id);
    const row = await this.repo.getRow(type, id);
    if (!row) throw new NotFoundException({ code: 'not_found' });
    return type === 'daily_reading' ? { ...row, sections: await this.repo.getSections(String(row.id)) } : row;
  }

  async create(type: EntityType, body: unknown, userId: string) {
    const data = this.parse(type, body, false);
    const { sections, ...fields } = data as { sections?: ReadingSection[] } & Record<string, unknown>;
    const row = await this.repo.insertRow(type, fields, userId);
    if (type === 'daily_reading' && sections) await this.repo.replaceSections(String(row.id), sections);
    await this.repo.audit({ actor_id: userId, action: 'content.create', entity_type: type, entity_id: String(row[TABLES[type].pk]), after_data: { version: row.version } });
    return type === 'daily_reading' ? { ...row, sections: sections ?? [] } : row;
  }

  async update(type: EntityType, id: string, body: unknown, userId: string) {
    assertValidId(type, id);
    const data = this.parse(type, body, true);
    const { sections, ...fields } = data as { sections?: ReadingSection[] } & Record<string, unknown>;
    const before = await this.repo.getRow(type, id);
    if (!before) throw new NotFoundException({ code: 'not_found' });
    if (before.status === 'archived') throw new ConflictException({ code: 'archived' });
    const row = Object.keys(fields).length || type !== 'daily_reading'
      ? await this.repo.updateRow(type, id, fields, userId)
      : await this.repo.updateRow(type, id, {}, userId); // sections-only change still bumps the version
    if (type === 'daily_reading' && sections) await this.repo.replaceSections(String(row.id), sections);
    await this.repo.audit({ actor_id: userId, action: 'content.update', entity_type: type, entity_id: id, before_data: { version: before.version }, after_data: { version: row.version, fields: Object.keys(data) } });
    return type === 'daily_reading' ? { ...row, sections: sections ?? (await this.repo.getSections(String(row.id))) } : row;
  }

  /** Publishes all items together or none of them. */
  async publish(items: Array<{ type: EntityType; id: string }>, note: string | null, userId: string) {
    const unique = [...new Map(items.map((i) => [`${i.type}:${i.id}`, i])).values()];
    if (!unique.length || unique.length > MAX_PUBLISH_ITEMS) throw new BadRequestException({ code: 'invalid_batch_size', max: MAX_PUBLISH_ITEMS });
    for (const i of unique) assertValidId(i.type, i.id);

    const loaded = await Promise.all(unique.map(async (i) => ({ ...i, row: await this.repo.getRow(i.type, i.id) })));
    const problems: Array<{ type: string; id: string; messages: string[] }> = [];
    const sectionsByKey = new Map<string, ReadingSection[]>();
    for (const l of loaded) {
      if (!l.row) { problems.push({ type: l.type, id: l.id, messages: ['not found'] }); continue; }
      if (l.row.status === 'archived') { problems.push({ type: l.type, id: l.id, messages: ['archived items cannot be published'] }); continue; }
      const secs = l.type === 'daily_reading' ? await this.repo.getSections(String(l.row.id)) : [];
      sectionsByKey.set(`${l.type}:${l.id}`, secs);
      const m = publishProblems(l.type, l.row, secs);
      if (m.length) problems.push({ type: l.type, id: l.id, messages: m });
    }
    if (problems.length) throw new UnprocessableEntityException({ code: 'not_publishable', problems });

    const assetIds = new Set<string>();
    for (const l of loaded) for (const f of TABLES[l.type].assetFields) { const v = (l.row as Row)[f]; if (typeof v === 'string') assetIds.add(v); }
    const assets = await this.repo.getAssets([...assetIds]);
    const missing = [...assetIds].filter((a) => !assets.has(a));
    if (missing.length) throw new UnprocessableEntityException({ code: 'missing_assets', count: missing.length });

    const url = loadEnv().SUPABASE_URL;
    const commitItems = loaded.map((l) => ({
      entity_type: l.type, entity_id: l.id, version: (l.row as Row).version, deleted: false,
      payload: buildPayload(l.type, l.row as Row, assets, url, sectionsByKey.get(`${l.type}:${l.id}`)),
    }));

    const batchId = await this.repo.createBatch(userId, note);
    let lastSeq: number;
    try { lastSeq = await this.repo.commitBatch(batchId, commitItems); }
    catch (e) { await this.repo.failBatch(batchId).catch(() => undefined); throw e; }

    // Content is already live at this point; a failure below only leaves a stale draft status, never a partial publish.
    for (const l of loaded) {
      try { await this.repo.setStatus(l.type, l.id, 'published', userId); }
      catch { this.log.warn(`status update failed after publish for ${l.type}`); }
    }
    await this.repo.audit({ actor_id: userId, action: 'content.publish', entity_type: 'batch', entity_id: batchId, after_data: { count: loaded.length, seq: lastSeq } });
    return { batchId, count: loaded.length, cursor: lastSeq };
  }

  async unpublish(type: EntityType, id: string, archive: boolean, userId: string) {
    assertValidId(type, id);
    const row = await this.repo.getRow(type, id);
    if (!row) throw new NotFoundException({ code: 'not_found' });
    const live = (await this.repo.liveVersions(type)).get(id);
    let cursor: number | null = null;
    if (live && !live.deleted) {
      const batchId = await this.repo.createBatch(userId, archive ? 'archive' : 'unpublish');
      try { cursor = await this.repo.commitBatch(batchId, [{ entity_type: type, entity_id: id, version: row.version, deleted: true }]); }
      catch (e) { await this.repo.failBatch(batchId).catch(() => undefined); throw e; }
    }
    await this.repo.setStatus(type, id, archive ? 'archived' : 'draft', userId);
    await this.repo.audit({ actor_id: userId, action: archive ? 'content.archive' : 'content.unpublish', entity_type: type, entity_id: id });
    return { cursor, wasLive: !!(live && !live.deleted) };
  }
}
