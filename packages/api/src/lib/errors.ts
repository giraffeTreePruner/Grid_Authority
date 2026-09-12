/**
 * The single error shape every endpoint returns.
 *
 * `{"error": {"code": "...", "message": "..."}}` with an appropriate status, so a
 * client can branch on `code` without parsing prose.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, 'bad_request', message);
  }

  static unavailable(message: string): ApiError {
    return new ApiError(503, 'unavailable', message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

export const errorBody = (code: string, message: string): ErrorBody => ({
  error: { code, message },
});
