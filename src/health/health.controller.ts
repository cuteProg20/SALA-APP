import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DataRepository } from '../supabase/data.repository';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly repo: DataRepository) {}
  /** Liveness: process is up. */
  @Get('healthz') live() { return { status: 'ok' }; }
  /** Readiness: dependencies reachable. DigitalOcean should route traffic only when this passes. */
  @Get('readyz')
  async ready() {
    let ok = false;
    try { ok = await this.repo.ping(); } catch { ok = false; }
    if (!ok) throw new ServiceUnavailableException({ status: 'unavailable' });
    return { status: 'ready' };
  }
}
