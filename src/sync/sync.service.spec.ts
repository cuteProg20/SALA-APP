import { SyncService } from './sync.service';
import { DataRepository, PublishedChange } from '../supabase/data.repository';

const row = (n: number): PublishedChange => ({ entity_type: 'category', entity_id: `c${n}`, version: 1, payload: {}, deleted: false, change_seq: n });
const repoWith = (all: PublishedChange[]) =>
  ({ fetchChanges: async (after: number, limit: number) => all.filter((r) => r.change_seq > after).slice(0, limit), maxChangeSeq: async () => all.at(-1)?.change_seq ?? 0 }) as unknown as DataRepository;

describe('SyncService', () => {
  const all = Array.from({ length: 5 }, (_, i) => row(i + 1));
  it('pages through all changes exactly once', async () => {
    const svc = new SyncService(repoWith(all));
    const seen: number[] = []; let cursor = 0; let more = true;
    while (more) { const r = await svc.pull(cursor, 2); seen.push(...r.items.map((i) => i.change_seq)); cursor = r.cursor; more = r.hasMore; }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
  it('keeps the cursor when nothing is new', async () => {
    const r = await new SyncService(repoWith(all)).pull(5, 10);
    expect(r).toEqual({ items: [], cursor: 5, hasMore: false });
  });
  it('clamps oversize page requests', async () => {
    let asked = 0;
    const svc = new SyncService({ fetchChanges: async (_a: number, l: number) => { asked = l; return []; } } as unknown as DataRepository);
    await svc.pull(0, 99999);
    expect(asked).toBe(201);
  });
  it('returns tombstones so deletions propagate', async () => {
    const t = { ...row(1), deleted: true, payload: null };
    const r = await new SyncService(repoWith([t])).pull(0, 10);
    expect(r.items[0].deleted).toBe(true);
  });
});
