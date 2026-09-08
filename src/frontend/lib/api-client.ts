import {
  API_BASE_PATH,
  apiContract,
  buildPath,
  type ApiErrorCode,
  type EndpointDefinition,
  type EndpointId,
  type HasBody,
  type HasParams,
  type HasQuery,
  type PathParams,
  type RequestBody,
  type RequestQuery,
  type ResponseData,
} from '../../shared';

/**
 * A single typed client generated from the shared contract (T32).
 *
 * There is exactly one function, {@link api}, rather than one hand-written method per
 * endpoint: `apiContract` already carries the method, path template and Zod schemas
 * for every route, so a second, hand-maintained list of the same endpoints would only
 * ever be a place for the two to drift. Call sites still get full inference —
 * `api('locks.create', { body: {...} })` narrows `body` and the return type from the
 * `EndpointId` literal alone.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: { path: string; message: string }[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown by {@link api} specifically on a 401, so callers can special-case "log in again". */
export class UnauthenticatedError extends ApiError {}

// The "nothing here" branches intersect as `{}` rather than `Record<string, never>` —
// the latter carries an implicit `[x: string]: never` index signature, which would
// force every property contributed by the *other* branches (e.g. `body`) down to
// `never` too once intersected. `{}` imposes no such constraint.
type CallArgs<K extends EndpointId> = (HasParams<K> extends true ? { params: PathParams<K> } : object) &
  (HasQuery<K> extends true ? { query: RequestQuery<K> } : object) &
  (HasBody<K> extends true ? { body: RequestBody<K> } : object);

let csrfToken: string | undefined;

/** Called once after login/session-fetch; every mutation after this carries the token. */
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

/** Stringifies a query value without ever risking `[object Object]` — every leaf in a
 * query object is a string, number or boolean by the time it reaches here. */
function stringifyQueryValue(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function toQueryString(query: Record<string, unknown> | undefined): string {
  if (query === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, stringifyQueryValue(value));
    }
  }
  const s = params.toString();
  return s.length > 0 ? `?${s}` : '';
}

/**
 * Calls one endpoint from the shared contract.
 *
 * Always sends cookies (the session lives there) and always parses the uniform
 * envelope — a non-2xx or an `{ ok: false }` body both become a thrown {@link ApiError}
 * so every call site has exactly one success path to write.
 */
export async function api<K extends EndpointId>(
  endpoint: K,
  args: CallArgs<K> = {} as CallArgs<K>,
): Promise<ResponseData<K>> {
  const def: EndpointDefinition = apiContract[endpoint];
  const a = args as { params?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
  const path = def.params !== undefined ? buildPath(endpoint, a.params ?? {}) : `${API_BASE_PATH}${def.path}`;
  const url = `${path}${toQueryString(a.query)}`;

  const headers: Record<string, string> = {};
  if (a.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (def.mutates === true && csrfToken !== undefined) {
    headers['x-csrf-token'] = csrfToken;
  }

  const res = await fetch(url, {
    method: def.method,
    credentials: 'include',
    headers,
    ...(a.body !== undefined ? { body: JSON.stringify(a.body) } : {}),
  });

  if (def.produces === 'binary') {
    if (!res.ok) {
      throw new ApiError('INTERNAL_ERROR', `Request failed with status ${res.status}`, res.status);
    }
    return await res.blob();
  }

  const json = (await res.json().catch(() => undefined)) as
    | { ok: true; data: ResponseData<K> }
    | { ok: false; error: { code: ApiErrorCode; message: string; details?: { path: string; message: string }[]; retryAfterSeconds?: number } }
    | undefined;

  if (json?.ok !== true) {
    const code = json?.ok === false ? json.error.code : 'INTERNAL_ERROR';
    const message = json?.ok === false ? json.error.message : `Request failed with status ${res.status}`;
    const details = json?.ok === false ? json.error.details : undefined;
    const retryAfterSeconds = json?.ok === false ? json.error.retryAfterSeconds : undefined;
    const ErrorClass = res.status === 401 ? UnauthenticatedError : ApiError;
    throw new ErrorClass(code, message, res.status, details, retryAfterSeconds);
  }

  return json.data;
}
