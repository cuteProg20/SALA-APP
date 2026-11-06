import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DataRepository } from '../supabase/data.repository';

const MB = 1024 * 1024;
/** Extension comes from the allow-listed MIME type, never from the client's filename. */
const ALLOWED: Record<string, { ext: string; kind: 'image' | 'audio' | 'video' | 'document'; max: number }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image', max: 5 * MB },
  'image/png': { ext: 'png', kind: 'image', max: 5 * MB },
  'image/webp': { ext: 'webp', kind: 'image', max: 5 * MB },
  'audio/mpeg': { ext: 'mp3', kind: 'audio', max: 100 * MB },
  'audio/mp4': { ext: 'm4a', kind: 'audio', max: 100 * MB },
  'video/mp4': { ext: 'mp4', kind: 'video', max: 500 * MB },
  'application/pdf': { ext: 'pdf', kind: 'document', max: 50 * MB },
};

export const uploadRequest = z.object({
  mime_type: z.string(), bytes: z.number().int().positive(),
  license_note: z.string().trim().min(3).max(500), // rights/permission record is mandatory
}).strict();

export const externalRequest = z.object({
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'must be https'),
  kind: z.enum(['video', 'audio']), license_note: z.string().trim().min(3).max(500),
}).strict();

@Injectable()
export class MediaService {
  constructor(private readonly repo: DataRepository) {}
  async createUpload(body: unknown, userId: string) {
    const r = uploadRequest.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'validation', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const rule = ALLOWED[r.data.mime_type];
    if (!rule) throw new BadRequestException({ code: 'unsupported_type', allowed: Object.keys(ALLOWED) });
    if (r.data.bytes > rule.max) throw new BadRequestException({ code: 'too_large', max_bytes: rule.max });
    const path = `${rule.kind}/${randomUUID()}.${rule.ext}`;
    const up = await this.repo.createSignedUpload(path);
    const asset = await this.repo.insertMediaAsset({ kind: rule.kind, storage_path: path, mime_type: r.data.mime_type, bytes: r.data.bytes, license_note: r.data.license_note, created_by: userId });
    await this.repo.audit({ actor_id: userId, action: 'media.upload_url', entity_type: 'media_asset', entity_id: asset.id });
    return { asset_id: asset.id, upload_url: up.signedUrl, token: up.token, path: up.path };
  }

  /** Registers a hosted video/audio link (e.g. YouTube) as an asset. Only https links are accepted. */
  async createExternal(body: unknown, userId: string) {
    const r = externalRequest.safeParse(body);
    if (!r.success) throw new BadRequestException({ code: 'validation', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const mime = 'text/uri-list'; // marker: the app opens it as a link, not a file
    const asset = await this.repo.insertMediaAsset({ kind: r.data.kind, external_url: r.data.url, mime_type: mime, license_note: r.data.license_note, created_by: userId });
    await this.repo.audit({ actor_id: userId, action: 'media.external', entity_type: 'media_asset', entity_id: asset.id });
    return { asset_id: asset.id };
  }
}
