import { z } from 'zod';
import { SECRET_SENTINEL, SHARE_NAME_PATTERN } from '../constants';

/**
 * Leaf schemas reused across the whole contract.
 *
 * These run in the browser as well as on the server. Where a value is
 * security-relevant the backend re-validates it after canonicalisation
 * (ARCHITECTURE §5.6) — the schemas here are defence in depth and a source of
 * good error messages, never the only check.
 */

/** Database row identifier. */
export const entityIdSchema = z.number().int().positive();

/** Seconds since the Unix epoch. */
export const unixSecondsSchema = z.number().int().nonnegative();

/** Milliseconds since the Unix epoch — what the file index stores for mtimes. */
export const unixMillisSchema = z.number().int().nonnegative();

/** Path segment safe to use as a Samba section name and a directory name. */
export const shareNameSchema = z
  .string()
  .regex(
    SHARE_NAME_PATTERN,
    'Share name must be 1-32 characters of A-Z, a-z, 0-9, underscore or hyphen',
  );

/**
 * A path relative to a share root.
 *
 * Rejects everything that could escape the share: absolute paths, drive letters,
 * backslashes, `..` segments and embedded NUL bytes. Directory traversal is a hard
 * error everywhere in this system, never a warning.
 */
export const relPathSchema = z
  .string()
  .min(1, 'Path must not be empty')
  .max(4096, 'Path exceeds the maximum length')
  .refine((s) => !s.includes('\0'), 'Path must not contain a NUL byte')
  .refine((s) => !s.startsWith('/'), 'Path must be relative to the share root, not absolute')
  .refine((s) => !/^[a-zA-Z]:/.test(s), 'Path must not be drive-qualified')
  .refine((s) => !s.includes('\\'), 'Path must use forward slashes')
  .refine((s) => !s.split('/').includes('..'), 'Path must not contain a ".." segment');

/** Same rules as {@link relPathSchema} but an empty string means "the share root". */
export const relPathOrRootSchema = z.union([z.literal(''), relPathSchema]);

/** An absolute POSIX path on the bridge itself. */
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .startsWith('/', 'Path must be absolute')
  .refine((s) => !s.includes('\0'), 'Path must not contain a NUL byte')
  .refine((s) => !s.split('/').includes('..'), 'Path must not contain a ".." segment');

/** A UNC path identifying the server-side share, e.g. `//fileserver/cnc$/programs`. */
export const uncPathSchema = z
  .string()
  .regex(
    /^\/\/[A-Za-z0-9._-]{1,253}\/[^/\\:*?"<>|\0]{1,255}(\/[^/\\:*?"<>|\0]{1,255})*$/,
    'Expected a UNC path such as //fileserver/share/subfolder',
  );

/** Kernel network interface name, e.g. `eth0`. */
export const interfaceNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,15}$/, 'Invalid network interface name');

export const ipv4Schema = z.string().ip({ version: 'v4' });
export const ipv6Schema = z.string().ip({ version: 'v6' });
export const ipAddressSchema = z.string().ip();

/** IPv4 address with prefix length, e.g. `192.168.42.1/24`. */
export const ipv4CidrSchema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:3[0-2]|[12]?\d)$/,
    'Expected an IPv4 address with prefix length, e.g. 192.168.42.1/24',
  );

export const macAddressSchema = z
  .string()
  .regex(
    /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/,
    'Expected a MAC address such as b8:27:eb:00:11:22',
  );

export const portSchema = z.number().int().min(1).max(65535);

export const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/,
    'Invalid hostname',
  );

/** sha256, lowercase hex — also the blob address in the version store. */
export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex digest');

/** xxhash64, lowercase hex — used for cheap change detection only, never for addressing. */
export const xxhash64Schema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'Expected a lowercase xxhash64 digest');

/** Five-field cron expression. Full semantic validation happens in the scheduler (T41). */
export const cronSchema = z
  .string()
  .trim()
  .regex(
    /^(\S+\s+){4}\S+$/,
    'Expected a five-field cron expression, e.g. "0 3 * * 0" (minute hour day month weekday)',
  );

/** A picomatch glob used for exclude patterns and scheduled lock windows. */
export const globPatternSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !s.includes('\0'), 'Pattern must not contain a NUL byte');

export const percentSchema = z.number().min(0).max(100);

/**
 * A secret as it crosses the API boundary.
 *
 * Reads always emit {@link SECRET_SENTINEL}. Writes accept the sentinel to mean
 * "leave unchanged", so a client can round-trip a config section it fetched without
 * ever seeing or resubmitting the plaintext (T5).
 */
export const secretWriteSchema = z.string().max(1024);

/** Discriminates "unchanged" from a real new value on write. */
export const isSecretSentinel = (value: string): boolean => value === SECRET_SENTINEL;

/** Offset/limit pagination accepted by every list endpoint. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Wraps an item schema in the standard paginated list shape. */
export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
