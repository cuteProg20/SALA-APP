import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ContentService } from './content.service';
import { MediaService } from './media.service';
import { ENTITY_TYPES, EntityType, isEntityType } from './entities';

const READ = ['super_admin', 'publisher', 'editor', 'viewer'] as const;
const WRITE = ['super_admin', 'publisher', 'editor'] as const;
const PUBLISH = ['super_admin', 'publisher'] as const;

const listQuery = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
const publishBody = z.object({
  items: z.array(z.object({ type: z.enum(ENTITY_TYPES), id: z.string().max(64) }).strict()).min(1).max(100),
  note: z.string().trim().max(300).nullish(),
}).strict();
const unpublishBody = z.object({ archive: z.boolean().optional() }).strict();

function type(raw: string): EntityType {
  if (!isEntityType(raw)) throw new NotFoundException({ code: 'unknown_type' });
  return raw;
}
const uid = (req: { user: { id: string } }) => req.user.id;

/** Staff-only. Every route re-checks the caller's role in the database (the UI hiding a button is not authorization). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard, RolesGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly content: ContentService, private readonly media: MediaService) {}

  @Get('content/:type') @Roles(...READ)
  list(@Param('type') t: string, @Query() raw: Record<string, unknown>) {
    const q = listQuery.safeParse(raw);
    if (!q.success) throw new BadRequestException({ code: 'invalid_query' });
    return this.content.list(type(t), q.data);
  }

  @Get('content/:type/:id') @Roles(...READ)
  get(@Param('type') t: string, @Param('id') id: string) { return this.content.get(type(t), id); }

  @Post('content/:type') @Roles(...WRITE)
  create(@Param('type') t: string, @Body() body: unknown, @Req() req: { user: { id: string } }) { return this.content.create(type(t), body, uid(req)); }

  @Patch('content/:type/:id') @Roles(...WRITE)
  update(@Param('type') t: string, @Param('id') id: string, @Body() body: unknown, @Req() req: { user: { id: string } }) {
    return this.content.update(type(t), id, body, uid(req));
  }

  @Post('publish') @Roles(...PUBLISH)
  publish(@Body() raw: unknown, @Req() req: { user: { id: string } }) {
    const b = publishBody.safeParse(raw);
    if (!b.success) throw new BadRequestException({ code: 'validation' });
    return this.content.publish(b.data.items, b.data.note ?? null, uid(req));
  }

  @Post('content/:type/:id/unpublish') @Roles(...PUBLISH)
  unpublish(@Param('type') t: string, @Param('id') id: string, @Body() raw: unknown, @Req() req: { user: { id: string } }) {
    const b = unpublishBody.safeParse(raw ?? {});
    if (!b.success) throw new BadRequestException({ code: 'validation' });
    return this.content.unpublish(type(t), id, b.data.archive ?? false, uid(req));
  }

  @Post('media/upload-url') @Roles(...WRITE)
  upload(@Body() body: unknown, @Req() req: { user: { id: string } }) { return this.media.createUpload(body, uid(req)); }

  @Post('media/external') @Roles(...WRITE)
  external(@Body() body: unknown, @Req() req: { user: { id: string } }) { return this.media.createExternal(body, uid(req)); }
}
