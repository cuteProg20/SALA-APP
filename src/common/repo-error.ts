import { ArgumentsHost, Catch, ConflictException, ExceptionFilter, HttpException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';

export type RepoErrorKind = 'conflict' | 'invalid' | 'notfound' | 'unknown';
export class RepoError extends Error {
  constructor(readonly kind: RepoErrorKind, message: string = kind) { super(message); }
}

/** Maps data-layer failures to HTTP without leaking SQL/driver details. */
@Catch(RepoError)
export class RepoErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Repo');
  catch(e: RepoError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let ex: HttpException;
    if (e.kind === 'conflict') ex = new ConflictException({ code: 'conflict' });
    else if (e.kind === 'invalid') ex = new BadRequestException({ code: 'invalid_reference' });
    else if (e.kind === 'notfound') ex = new NotFoundException({ code: 'not_found' });
    else { this.log.error(`data layer failure: ${e.message}`); res.status(500).json({ statusCode: 500, message: 'Internal server error' }); return; }
    res.status(ex.getStatus()).json(ex.getResponse());
  }
}
