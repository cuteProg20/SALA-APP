import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { DataRepository } from '../supabase/data.repository';

/** Minimum age is a product assumption (13+); adjust here once the policy is confirmed. */
export const MIN_AGE = 13;
const name = z.string().trim().min(1).max(80);
const createProfile = z.object({
  first_name: name, middle_name: z.string().trim().max(80).nullish(), last_name: name,
  age: z.number().int().min(MIN_AGE).max(120), locale: z.enum(['en', 'sw']).default('en'),
}).strict();
// Built without defaults: a default inside a PATCH would silently overwrite stored values.
const patchProfile = createProfile.omit({ locale: true }).extend({ locale: z.enum(['en', 'sw']) }).partial().strict();
const progress = z.object({ chapters_read: z.number().int().min(0).max(10000) }).strict();
const device = z.object({ platform: z.enum(['android', 'ios']), token: z.string().min(10).max(4096) }).strict();

type Req = { user: { id: string } };

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(private readonly repo: DataRepository) {}

  @Get()
  async me(@Req() req: Req) {
    const p = await this.repo.getProfile(req.user.id);
    if (!p) throw new NotFoundException({ code: 'profile_required' }); // app should show the registration form
    return p;
  }

  @Post()
  async create(@Body() raw: unknown, @Req() req: Req) {
    const b = createProfile.safeParse(raw);
    if (!b.success) throw new BadRequestException({ code: 'validation', issues: b.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (await this.repo.getProfile(req.user.id)) throw new ConflictException({ code: 'profile_exists' });
    const phone = await this.repo.authPhone(req.user.id); // taken from the verified account, never from the request body
    if (!phone) throw new BadRequestException({ code: 'phone_required' });
    return this.repo.createProfile({ id: req.user.id, phone_e164: phone, ...b.data, middle_name: b.data.middle_name ?? null });
  }

  @Patch()
  async update(@Body() raw: unknown, @Req() req: Req) {
    const b = patchProfile.safeParse(raw);
    if (!b.success || !Object.keys(b.data).length) throw new BadRequestException({ code: 'validation' });
    if (!(await this.repo.getProfile(req.user.id))) throw new NotFoundException({ code: 'profile_required' });
    return this.repo.updateProfile(req.user.id, b.data);
  }

  @Get('data')
  data(@Req() req: Req) { return this.repo.getUserData(req.user.id); }

  @Put('progress/:itemId') @HttpCode(204)
  async setProgress(@Param('itemId', new ParseUUIDPipe()) itemId: string, @Body() raw: unknown, @Req() req: Req) {
    const b = progress.safeParse(raw);
    if (!b.success) throw new BadRequestException({ code: 'validation' });
    await this.repo.upsertProgress(req.user.id, itemId, b.data.chapters_read);
  }

  @Put('saved/:mediaId') @HttpCode(204)
  async save(@Param('mediaId', new ParseUUIDPipe()) id: string, @Req() req: Req) { await this.repo.setSaved(req.user.id, id, true); }
  @Delete('saved/:mediaId') @HttpCode(204)
  async unsave(@Param('mediaId', new ParseUUIDPipe()) id: string, @Req() req: Req) { await this.repo.setSaved(req.user.id, id, false); }

  @Put('subscriptions/:channelId') @HttpCode(204)
  async sub(@Param('channelId', new ParseUUIDPipe()) id: string, @Req() req: Req) { await this.repo.setSubscription(req.user.id, id, true); }
  @Delete('subscriptions/:channelId') @HttpCode(204)
  async unsub(@Param('channelId', new ParseUUIDPipe()) id: string, @Req() req: Req) { await this.repo.setSubscription(req.user.id, id, false); }

  @Put('device-token') @HttpCode(204)
  async token(@Body() raw: unknown, @Req() req: Req) {
    const b = device.safeParse(raw);
    if (!b.success) throw new BadRequestException({ code: 'validation' });
    await this.repo.upsertDeviceToken(req.user.id, b.data.platform, b.data.token);
  }

  /** Permanent account deletion (required by both app stores). */
  @Delete() @HttpCode(204)
  async remove(@Req() req: Req) { await this.repo.deleteAccount(req.user.id); }
}
