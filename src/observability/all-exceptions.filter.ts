import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { captureException } from "./sentry";

/**
 * Global HTTP exception filter. Preserves Nest's normal error responses, and
 * additionally reports UNEXPECTED errors (non-HttpException, or 5xx) to Sentry
 * with the request path/method. Normal 4xx client errors (BadRequest,
 * Unauthorized, …) are NOT sent to Sentry — they're expected.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res: any = ctx.getResponse();
    const req: any = ctx.getRequest();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp
      ? exception.getResponse()
      : { statusCode: status, message: "Internal server error" };

    if (!isHttp || status >= 500) {
      captureException(exception, { path: req?.url, method: req?.method });
      this.log.error(
        `${req?.method ?? "?"} ${req?.url ?? "?"} → ${status}: ${
          (exception as Error)?.message ?? String(exception)
        }`,
      );
    }

    // Guard: only respond on an HTTP context (skip WS/other transports).
    if (res && typeof res.status === "function") {
      res
        .status(status)
        .json(typeof payload === "string" ? { statusCode: status, message: payload } : payload);
    }
  }
}
