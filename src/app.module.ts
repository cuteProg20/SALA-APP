import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthController } from './health/health.controller';
import { SyncController } from './sync/sync.controller';
import { SyncService } from './sync/sync.service';
import { DataRepository } from './supabase/data.repository';
import { SupabaseRepository } from './supabase/supabase.repository';
import { AuthGuard } from './auth/auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AdminController } from './content/admin.controller';
import { ContentService } from './content/content.service';
import { MediaService } from './content/media.service';
import { MeController } from './me/me.controller';
import { RepoErrorFilter } from './common/repo-error';
import { SendSmsController } from './hooks/send-sms.controller';
import { SmsProvider } from './sms/sms.provider';
import { BeemSmsProvider } from './sms/beem.provider';

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [HealthController, SyncController, SendSmsController, AdminController, MeController],
  providers: [
    SyncService, ContentService, MediaService, AuthGuard, RolesGuard,
    { provide: APP_FILTER, useClass: RepoErrorFilter },
    { provide: DataRepository, useClass: SupabaseRepository },
    { provide: SmsProvider, useFactory: () => new BeemSmsProvider() },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
