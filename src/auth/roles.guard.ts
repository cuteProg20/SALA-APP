import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataRepository, StaffRole } from '../supabase/data.repository';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

/** Server-side authorization: looks the caller up in staff_members on every request. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly repo: DataRepository) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const needed = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!needed?.length) return true;
    const userId = ctx.switchToHttp().getRequest().user?.id as string | undefined;
    if (!userId) throw new ForbiddenException();
    const role = await this.repo.staffRole(userId);
    if (!role || !needed.includes(role)) throw new ForbiddenException();
    return true;
  }
}
