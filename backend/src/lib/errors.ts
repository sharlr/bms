export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}

export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
export const conflict = (msg: string) => new HttpError(409, msg, 'conflict');

export function assert(cond: unknown, err: HttpError): asserts cond {
  if (!cond) throw err;
}
