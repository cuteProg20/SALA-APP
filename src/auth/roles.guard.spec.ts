import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { DataRepository, StaffRole } from '../supabase/data.repository';

const ctx = (userId?: string) => ({
  getHandler: () => ({}), getClass: () => ({}),
  switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
}) as unknown as ExecutionContext;
const guard = (needed: StaffRole[] | undefined, role: StaffRole | null) =>
  new RolesGuard({ getAllAndOverride: () => needed } as unknown as Reflector, { staffRole: async () => role } as unknown as DataRepository);

describe('RolesGuard', () => {
  it('allows routes with no role requirement', async () => { expect(await guard(undefined, null).canActivate(ctx('u'))).toBe(true); });
  it('allows a matching role', async () => { expect(await guard(['publisher'], 'publisher').canActivate(ctx('u'))).toBe(true); });
  it('rejects a lower role', async () => { await expect(guard(['publisher'], 'viewer').canActivate(ctx('u'))).rejects.toBeInstanceOf(ForbiddenException); });
  it('rejects a non-staff user', async () => { await expect(guard(['viewer'], null).canActivate(ctx('u'))).rejects.toBeInstanceOf(ForbiddenException); });
  it('rejects when unauthenticated', async () => { await expect(guard(['viewer'], 'viewer').canActivate(ctx())).rejects.toBeInstanceOf(ForbiddenException); });
});
