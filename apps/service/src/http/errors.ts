import type { ZodError } from 'zod'

/** An error that the API turns into `{ error: { code, message, fix } }` with the given HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Builds an API error. Throw the result from a route. */
export function apiError(code: string, message: string, fix: string, status: number): ApiError {
  return new ApiError(code, message, fix, status)
}

/** A 400 `invalid_request` that names every wrong field. */
export function validationError(err: ZodError): ApiError {
  const message = err.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'body'}: ${i.message}`).join('; ')
  return apiError('invalid_request', message, 'Fix the listed fields and send the request again.', 400)
}
