import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { SyncService } from './sync.service';

const pullQuery = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  /** Incremental pull of published content with change_seq > cursor. Idempotent. */
  @Get()
  pull(@Query() raw: Record<string, unknown>) {
    const q = pullQuery.safeParse(raw);
    if (!q.success) throw new BadRequestException({ code: 'invalid_query', fields: q.error.issues.map((i) => i.path.join('.')) });
    return this.sync.pull(q.data.cursor, q.data.limit);
  }

  /** Cheap "anything new?" probe so an up-to-date app downloads nothing. */
  @Get('head')
  head() {
    return this.sync.head();
  }
}
