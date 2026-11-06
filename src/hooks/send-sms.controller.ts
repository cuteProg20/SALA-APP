import { Controller, HttpCode, Logger, Post, Req, ServiceUnavailableException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { loadEnv } from '../config/env';
import { SmsDeliveryError, SmsProvider } from '../sms/sms.provider';
import { verifyWebhook } from './webhook-signature';

const payload = z.object({
  user: z.object({ phone: z.string() }).passthrough(),
  sms: z.object({ otp: z.string().regex(/^[0-9]{4,10}$/) }),
});

/** Message kept short: one SMS segment, bilingual (Swahili / English). */
export const otpMessage = (otp: string) => `SALA: Namba yako ni ${otp}. Your code is ${otp}.`;

/** Called by Supabase Auth ("Send SMS" hook) to deliver a login code. Not for apps or browsers. */
@ApiExcludeController()
@SkipThrottle() // authenticity is proven by the signature; Supabase rate-limits OTP requests itself
@Controller({ path: 'hooks', version: '1' })
export class SendSmsController {
  private readonly log = new Logger(SendSmsController.name);
  constructor(private readonly sms: SmsProvider) {}

  @Post('send-sms')
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>) {
    const env = loadEnv();
    if (!env.SUPABASE_SMS_HOOK_SECRET) throw new ServiceUnavailableException();
    const h = req.headers;
    const ok = verifyWebhook({
      secret: env.SUPABASE_SMS_HOOK_SECRET,
      id: h['webhook-id'] as string | undefined,
      timestamp: h['webhook-timestamp'] as string | undefined,
      signature: h['webhook-signature'] as string | undefined,
      rawBody: req.rawBody ?? '',
    });
    if (!ok) throw new UnauthorizedException();

    const parsed = payload.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException();
    const phone = parsed.data.user.phone.startsWith('+') ? parsed.data.user.phone : `+${parsed.data.user.phone}`;

    try {
      await this.sms.send(phone, otpMessage(parsed.data.sms.otp));
    } catch (e) {
      const err = e as SmsDeliveryError;
      this.log.warn(`sms delivery failed (retryable=${err.retryable ?? 'unknown'})`); // no number, no code
      throw new ServiceUnavailableException();
    }
    return {};
  }
}
