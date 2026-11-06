import { Injectable } from '@nestjs/common';
import { DataRepository, PublishedChange } from '../supabase/data.repository';

export const MAX_PAGE = 200;

@Injectable()
export class SyncService {
  constructor(private readonly repo: DataRepository) {}

  async pull(cursor: number, limit: number): Promise<{ items: PublishedChange[]; cursor: number; hasMore: boolean }> {
    const size = Math.min(Math.max(limit, 1), MAX_PAGE);
    const rows = await this.repo.fetchChanges(cursor, size + 1); // +1 reveals whether more remain
    const hasMore = rows.length > size;
    const items = rows.slice(0, size);
    return { items, cursor: items.length ? items[items.length - 1].change_seq : cursor, hasMore };
  }

  async head(): Promise<{ cursor: number }> {
    return { cursor: await this.repo.maxChangeSeq() };
  }
}
