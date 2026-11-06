/** Port for sending SMS. The only implementation that touches the network is BeemSmsProvider. */
export abstract class SmsProvider {
  /** @param e164 recipient in E.164 form, e.g. +255712345678 */
  abstract send(e164: string, message: string): Promise<void>;
}

export class SmsDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
