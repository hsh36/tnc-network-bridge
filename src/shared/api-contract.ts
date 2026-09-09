import { z } from 'zod';
import { API_BASE_PATH } from './constants';
import {
  acceptedSchema,
  acknowledgedSchema,
  type apiErrorSchema,
  apiSuccess,
  apiTokenSchema,
  applyFirewallResponseSchema,
  applyUpdateRequestSchema,
  certificateInfoSchema,
  changePasswordRequestSchema,
  completeSetupRequestSchema,
  configSectionNameSchema,
  configSectionSchemas,
  conflictSchema,
  createLockRequestSchema,
  createScheduleRequestSchema,
  createShareRequestSchema,
  createTokenRequestSchema,
  createTokenResponseSchema,
  eventStreamQuerySchema,
  fail2banStatusSchema,
  fileIndexEntrySchema,
  fileVersionSchema,
  firewallConfigSchema,
  healthSchema,
  listConflictsQuerySchema,
  listFilesQuerySchema,
  listLocksQuerySchema,
  listLogsQuerySchema,
  listSchedulesQuerySchema,
  listVersionsQuerySchema,
  lockSchema,
  logEntrySchema,
  loginRequestSchema,
  metricsQuerySchema,
  metricsResponseSchema,
  networkInterfacesResponseSchema,
  paginated,
  paginationQuerySchema,
  previewScheduleRequestSchema,
  previewScheduleResponseSchema,
  pinVersionRequestSchema,
  prtgResponseSchema,
  regenerateCertificateRequestSchema,
  releaseLockQuerySchema,
  resolveConflictRequestSchema,
  restartTargetSchema,
  restoreVersionRequestSchema,
  restoreVersionResponseSchema,
  runScheduleResponseSchema,
  scheduleSchema,
  sessionInfoSchema,
  setupPasswordRequestSchema,
  setupStatusSchema,
  shareActionSchema,
  shareRuntimeSchema,
  shareSchema,
  statusSchema,
  systemInfoSchema,
  testAdRequestSchema,
  testAdResponseSchema,
  testNetworkRequestSchema,
  testNetworkResponseSchema,
  testSmbRequestSchema,
  testSmbResponseSchema,
  tncClientSchema,
  unbanRequestSchema,
  updateHistoryEntrySchema,
  updateHistoryQuerySchema,
  updateScheduleRequestSchema,
  updateShareRequestSchema,
  updateStatusSchema,
  updateTncClientRequestSchema,
  uploadCertificateRequestSchema,
  type ConfigSectionName,
} from './schemas';

/**
 * The single source of truth for the REST surface (IMPLEMENTATION_PLAN §5).
 *
 * The backend mounts its routes from these definitions and validates against them
 * (T29); the frontend generates its typed client from them (T32). Because both sides
 * read the same object, an endpoint cannot drift between them — a shape change breaks
 * compilation on whichever side did not follow.
 *
 * All request and response types are *inferred* from the Zod schemas. Nothing in the
 * contract is a hand-written interface.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * `session` — browser only.
 * `session-or-token` — also reachable with a read-only `X-API-Key` (monitoring).
 * `public` — no credentials; `/health` is additionally restricted to localhost.
 */
export type AuthMode = 'public' | 'session' | 'session-or-token';

/** What the endpoint writes on the wire. Everything but `json` bypasses the envelope. */
export type Produces = 'json' | 'text' | 'binary' | 'sse';

export interface EndpointDefinition {
  readonly method: HttpMethod;
  /** Relative to {@link API_BASE_PATH}, with `:name` path parameters. */
  readonly path: string;
  readonly summary: string;
  readonly auth: AuthMode;
  readonly params?: z.ZodTypeAny;
  readonly query?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  /** The `data` payload inside the success envelope, unless `produces` says otherwise. */
  readonly response: z.ZodTypeAny;
  readonly produces?: Produces;
  /** True where the response is deliberately not wrapped in the standard envelope. */
  readonly unenveloped?: true;
  /** Mutating endpoints require a CSRF token and are written to the audit log. */
  readonly mutates?: true;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * `/config/:section` is polymorphic in its section: the real schema is
 * `configSectionSchemas[section]`, which both the server-side validator and the
 * frontend client select at call time. A union would be actively harmful here —
 * every section schema has defaults for all of its fields, so an empty object parses
 * successfully against any of them and a union would silently accept the wrong
 * section's payload.
 */
const configPayloadSchema = z.record(z.unknown());

/** Selects the true schema for a section. Use this, never {@link configPayloadSchema}. */
export const getConfigSectionSchema = <K extends ConfigSectionName>(
  section: K,
): (typeof configSectionSchemas)[K] => configSectionSchemas[section];

export const apiContract = {
  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  'auth.login': {
    method: 'POST',
    path: '/auth/login',
    summary: 'Establish a session. Rate limited to 5 attempts per 15 minutes per IP.',
    auth: 'public',
    body: loginRequestSchema,
    response: sessionInfoSchema,
    mutates: true,
  },
  'auth.logout': {
    method: 'POST',
    path: '/auth/logout',
    summary: 'Revoke the current session.',
    auth: 'session',
    response: acknowledgedSchema,
    mutates: true,
  },
  'auth.session': {
    method: 'GET',
    path: '/auth/session',
    summary: 'Current session and the CSRF token required for mutations.',
    auth: 'session',
    response: sessionInfoSchema,
  },
  'auth.changePassword': {
    method: 'POST',
    path: '/auth/password',
    summary: 'Change the admin password. All other sessions are revoked.',
    auth: 'session',
    body: changePasswordRequestSchema,
    response: acknowledgedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Status, health, metrics
  // -------------------------------------------------------------------------
  'status.get': {
    method: 'GET',
    path: '/status',
    summary: 'Aggregate state: shares, sync, server link, locks, version.',
    auth: 'session-or-token',
    response: statusSchema,
  },
  'health.get': {
    method: 'GET',
    path: '/health',
    summary: 'Liveness for the systemd watchdog and the update health gate. Localhost only.',
    auth: 'public',
    response: healthSchema,
  },
  'metrics.get': {
    method: 'GET',
    path: '/metrics',
    summary: 'Metric time series over a range.',
    auth: 'session-or-token',
    query: metricsQuerySchema,
    response: metricsResponseSchema,
  },
  'metrics.prometheus': {
    method: 'GET',
    path: '/metrics/prometheus',
    summary: 'Prometheus text exposition format.',
    auth: 'session-or-token',
    response: z.string(),
    produces: 'text',
    unenveloped: true,
  },
  'metrics.prtg': {
    method: 'GET',
    path: '/metrics/prtg',
    summary: 'PRTG HTTP Data Advanced sensor payload.',
    auth: 'session-or-token',
    response: prtgResponseSchema,
    unenveloped: true,
  },

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  'config.get': {
    method: 'GET',
    path: '/config/:section',
    summary: 'Read one configuration section. Secrets are redacted to the sentinel.',
    auth: 'session',
    params: z.object({ section: configSectionNameSchema }),
    response: configPayloadSchema,
  },
  'config.update': {
    method: 'PUT',
    path: '/config/:section',
    summary: 'Replace one configuration section. The secret sentinel means "unchanged".',
    auth: 'session',
    params: z.object({ section: configSectionNameSchema }),
    body: configPayloadSchema,
    response: configPayloadSchema,
    mutates: true,
  },
  'config.testSmb': {
    method: 'POST',
    path: '/config/test/smb',
    summary: 'Probe an SMB share and report dialect, signing, encryption and writability.',
    auth: 'session',
    body: testSmbRequestSchema,
    response: testSmbResponseSchema,
  },
  'config.testAd': {
    method: 'POST',
    path: '/config/test/ad',
    summary: 'Validate Active Directory service-account credentials.',
    auth: 'session',
    body: testAdRequestSchema,
    response: testAdResponseSchema,
  },
  'config.testNetwork': {
    method: 'POST',
    path: '/config/test/network',
    summary: 'Resolve and reach a host, reporting which interface the route uses.',
    auth: 'session',
    body: testNetworkRequestSchema,
    response: testNetworkResponseSchema,
  },

  // -------------------------------------------------------------------------
  // Shares
  // -------------------------------------------------------------------------
  'shares.list': {
    method: 'GET',
    path: '/shares',
    summary: 'All shares with their live runtime state.',
    auth: 'session-or-token',
    query: paginationQuerySchema,
    response: paginated(shareRuntimeSchema),
  },
  'shares.create': {
    method: 'POST',
    path: '/shares',
    summary: 'Create a share. Mount point and cache path are derived from the name.',
    auth: 'session',
    body: createShareRequestSchema,
    response: shareSchema,
    mutates: true,
  },
  'shares.get': {
    method: 'GET',
    path: '/shares/:id',
    summary: 'One share with its live runtime state.',
    auth: 'session-or-token',
    params: idParams,
    response: shareRuntimeSchema,
  },
  'shares.update': {
    method: 'PATCH',
    path: '/shares/:id',
    summary: 'Update a share. The name is immutable; renaming is delete-and-recreate.',
    auth: 'session',
    params: idParams,
    body: updateShareRequestSchema,
    response: shareSchema,
    mutates: true,
  },
  'shares.delete': {
    method: 'DELETE',
    path: '/shares/:id',
    summary: 'Delete a share, unmounting it and dropping its index.',
    auth: 'session',
    params: idParams,
    response: acknowledgedSchema,
    mutates: true,
  },
  'shares.action': {
    method: 'POST',
    path: '/shares/:id/:action',
    summary: 'Run scan, resync, pause, resume, mount or unmount against a share.',
    auth: 'session',
    params: idParams.extend({ action: shareActionSchema }),
    response: acceptedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // File index
  // -------------------------------------------------------------------------
  'files.list': {
    method: 'GET',
    path: '/files',
    summary: 'Browse the file index, filtered by share, path prefix, state or free text.',
    auth: 'session-or-token',
    query: listFilesQuerySchema,
    response: paginated(fileIndexEntrySchema),
  },

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------
  'locks.list': {
    method: 'GET',
    path: '/locks',
    summary: 'Active locks, optionally including released ones.',
    auth: 'session-or-token',
    query: listLocksQuerySchema,
    response: paginated(lockSchema),
  },
  'locks.create': {
    method: 'POST',
    path: '/locks',
    summary: 'Take a manual lock. Origin is forced to "manual" by the server.',
    auth: 'session',
    body: createLockRequestSchema,
    response: lockSchema,
    mutates: true,
  },
  'locks.release': {
    method: 'DELETE',
    path: '/locks/:id',
    summary: 'Release a lock. Force-releasing a TNC lock is recorded in the audit log.',
    auth: 'session',
    params: idParams,
    query: releaseLockQuerySchema,
    response: acknowledgedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------
  'conflicts.list': {
    method: 'GET',
    path: '/conflicts',
    summary: 'Conflict history, filterable by share and acknowledgement.',
    auth: 'session-or-token',
    query: listConflictsQuerySchema,
    response: paginated(conflictSchema),
  },
  'conflicts.resolve': {
    method: 'POST',
    path: '/conflicts/:id/resolve',
    summary: 'Promote one side of a conflict by restoring its captured version.',
    auth: 'session',
    params: idParams,
    body: resolveConflictRequestSchema,
    response: conflictSchema,
    mutates: true,
  },
  'conflicts.acknowledge': {
    method: 'POST',
    path: '/conflicts/:id/acknowledge',
    summary: 'Mark a conflict as reviewed without changing any file.',
    auth: 'session',
    params: idParams,
    response: conflictSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------
  'versions.list': {
    method: 'GET',
    path: '/versions',
    summary: 'Version history for a share, optionally narrowed to one path.',
    auth: 'session-or-token',
    query: listVersionsQuerySchema,
    response: paginated(fileVersionSchema),
  },
  'versions.download': {
    method: 'GET',
    path: '/versions/:id/download',
    summary: 'Download the stored blob for one version.',
    auth: 'session',
    params: idParams,
    response: z.unknown(),
    produces: 'binary',
    unenveloped: true,
  },
  'versions.restore': {
    method: 'POST',
    path: '/versions/:id/restore',
    summary: 'Restore a version through the normal sync path, capturing the pre-image first.',
    auth: 'session',
    params: idParams,
    body: restoreVersionRequestSchema,
    response: restoreVersionResponseSchema,
    mutates: true,
  },
  'versions.pin': {
    method: 'POST',
    path: '/versions/:id/pin',
    summary: 'Pin or unpin a version, exempting it from retention pruning.',
    auth: 'session',
    params: idParams,
    body: pinVersionRequestSchema,
    response: fileVersionSchema,
    mutates: true,
  },
  'versions.delete': {
    method: 'DELETE',
    path: '/versions/:id',
    summary: 'Delete one version. Its blob is removed only if no other version shares it.',
    auth: 'session',
    params: idParams,
    response: acknowledgedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Logs and event streams
  // -------------------------------------------------------------------------
  'logs.list': {
    method: 'GET',
    path: '/logs',
    summary: 'Query the SQLite log sink.',
    auth: 'session-or-token',
    query: listLogsQuerySchema,
    response: paginated(logEntrySchema),
  },
  'logs.stream': {
    method: 'GET',
    path: '/logs/stream',
    summary: 'Server-sent stream of log entries.',
    auth: 'session',
    query: eventStreamQuerySchema,
    response: logEntrySchema,
    produces: 'sse',
    unenveloped: true,
  },
  'events.stream': {
    method: 'GET',
    path: '/events/stream',
    summary: 'Server-sent stream of status, sync, lock, conflict and update events.',
    auth: 'session',
    query: eventStreamQuerySchema,
    response: z.unknown(),
    produces: 'sse',
    unenveloped: true,
  },

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------
  'system.get': {
    method: 'GET',
    path: '/system',
    summary: 'Host facts: disk, CPU, memory, SoC temperature, throttling, interfaces.',
    auth: 'session-or-token',
    response: systemInfoSchema,
  },
  'system.restart': {
    method: 'POST',
    path: '/system/:target',
    summary: 'Restart the service or reboot the host.',
    auth: 'session',
    params: z.object({ target: restartTargetSchema }),
    response: acceptedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------
  'schedules.list': {
    method: 'GET',
    path: '/schedules',
    summary: 'Cron entries with their computed next run.',
    auth: 'session-or-token',
    query: listSchedulesQuerySchema,
    response: paginated(scheduleSchema),
  },
  'schedules.create': {
    method: 'POST',
    path: '/schedules',
    summary: 'Create a cron entry.',
    auth: 'session',
    body: createScheduleRequestSchema,
    response: scheduleSchema,
    mutates: true,
  },
  'schedules.preview': {
    method: 'POST',
    path: '/schedules/preview',
    summary: 'Next occurrences of a cron expression, without saving it.',
    auth: 'session',
    body: previewScheduleRequestSchema,
    response: previewScheduleResponseSchema,
    mutates: true,
  },
  'schedules.get': {
    method: 'GET',
    path: '/schedules/:id',
    summary: 'One cron entry.',
    auth: 'session-or-token',
    params: idParams,
    response: scheduleSchema,
  },
  'schedules.update': {
    method: 'PATCH',
    path: '/schedules/:id',
    summary: 'Update a cron entry.',
    auth: 'session',
    params: idParams,
    body: updateScheduleRequestSchema,
    response: scheduleSchema,
    mutates: true,
  },
  'schedules.delete': {
    method: 'DELETE',
    path: '/schedules/:id',
    summary: 'Delete a cron entry.',
    auth: 'session',
    params: idParams,
    response: acknowledgedSchema,
    mutates: true,
  },
  'schedules.run': {
    method: 'POST',
    path: '/schedules/:id/run',
    summary: 'Run a cron entry immediately, without waiting for its next occurrence.',
    auth: 'session',
    params: idParams,
    response: runScheduleResponseSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Self-update
  // -------------------------------------------------------------------------
  'update.status': {
    method: 'GET',
    path: '/update/status',
    summary: 'Current version, available release and updater phase.',
    auth: 'session-or-token',
    response: updateStatusSchema,
  },
  'update.check': {
    method: 'POST',
    path: '/update/check',
    summary: 'Poll GitHub Releases on the configured channel now.',
    auth: 'session',
    response: updateStatusSchema,
    mutates: true,
  },
  'update.apply': {
    method: 'POST',
    path: '/update/apply',
    summary: 'Download, verify, install and restart, with an automatic rollback on failure.',
    auth: 'session',
    body: applyUpdateRequestSchema,
    response: acceptedSchema,
    mutates: true,
  },
  'update.rollback': {
    method: 'POST',
    path: '/update/rollback',
    summary: 'Switch back to the retained previous release.',
    auth: 'session',
    response: acceptedSchema,
    mutates: true,
  },
  'update.history': {
    method: 'GET',
    path: '/update/history',
    summary: 'Past update attempts and their outcomes.',
    auth: 'session-or-token',
    query: updateHistoryQuerySchema,
    response: paginated(updateHistoryEntrySchema),
  },

  // -------------------------------------------------------------------------
  // Network interfaces
  // -------------------------------------------------------------------------
  'network.interfaces': {
    method: 'GET',
    path: '/network/interfaces',
    summary: 'Every NIC on the machine, with its stored desired-state configuration.',
    auth: 'session',
    response: networkInterfacesResponseSchema,
  },

  // -------------------------------------------------------------------------
  // Certificates
  // -------------------------------------------------------------------------
  'certificates.get': {
    method: 'GET',
    path: '/certificates',
    summary: 'The live certificate: subject, SANs, validity, fingerprint.',
    auth: 'session',
    response: certificateInfoSchema,
  },
  'certificates.upload': {
    method: 'POST',
    path: '/certificates',
    summary: 'Install a custom certificate. Fully validated before the live one is replaced.',
    auth: 'session',
    body: uploadCertificateRequestSchema,
    response: certificateInfoSchema,
    mutates: true,
  },
  'certificates.regenerate': {
    method: 'POST',
    path: '/certificates/regenerate',
    summary: 'Generate a fresh self-signed certificate and hot-reload it.',
    auth: 'session',
    body: regenerateCertificateRequestSchema,
    response: certificateInfoSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Firewall
  // -------------------------------------------------------------------------
  'firewall.get': {
    method: 'GET',
    path: '/firewall',
    summary: 'Current nftables ruleset managed by the bridge.',
    auth: 'session',
    response: firewallConfigSchema,
  },
  'firewall.update': {
    method: 'PUT',
    path: '/firewall',
    summary: 'Replace the ruleset atomically, with a confirm-or-revert timer on lockout risk.',
    auth: 'session',
    body: firewallConfigSchema,
    response: applyFirewallResponseSchema,
    mutates: true,
  },
  'firewall.reset': {
    method: 'POST',
    path: '/firewall/reset',
    summary: 'Restore the default ruleset.',
    auth: 'session',
    response: firewallConfigSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Fail2Ban
  // -------------------------------------------------------------------------
  'fail2ban.status': {
    method: 'GET',
    path: '/fail2ban/status',
    summary: 'Jail state and currently banned addresses.',
    auth: 'session-or-token',
    response: fail2banStatusSchema,
  },
  'fail2ban.unban': {
    method: 'POST',
    path: '/fail2ban/unban',
    summary: 'Unban an address.',
    auth: 'session',
    body: unbanRequestSchema,
    response: acknowledgedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Discovered TNC machines
  // -------------------------------------------------------------------------
  'tncClients.list': {
    method: 'GET',
    path: '/tnc-clients',
    summary: 'Machines seen on the TNC segment, with their DHCP reservations.',
    auth: 'session-or-token',
    query: paginationQuerySchema,
    response: paginated(tncClientSchema),
  },
  'tncClients.get': {
    method: 'GET',
    path: '/tnc-clients/:id',
    summary: 'One discovered machine.',
    auth: 'session-or-token',
    params: idParams,
    response: tncClientSchema,
  },
  'tncClients.update': {
    method: 'PATCH',
    path: '/tnc-clients/:id',
    summary: 'Name a machine, set its model, or pin a DHCP reservation.',
    auth: 'session',
    params: idParams,
    body: updateTncClientRequestSchema,
    response: tncClientSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // API tokens
  // -------------------------------------------------------------------------
  'tokens.list': {
    method: 'GET',
    path: '/tokens',
    summary: 'API tokens. Values are never returned after creation.',
    auth: 'session',
    query: paginationQuerySchema,
    response: paginated(apiTokenSchema),
  },
  'tokens.create': {
    method: 'POST',
    path: '/tokens',
    summary: 'Create a read-only API token. The value is shown exactly once.',
    auth: 'session',
    body: createTokenRequestSchema,
    response: createTokenResponseSchema,
    mutates: true,
  },
  'tokens.delete': {
    method: 'DELETE',
    path: '/tokens/:id',
    summary: 'Revoke an API token.',
    auth: 'session',
    params: idParams,
    response: acknowledgedSchema,
    mutates: true,
  },

  // -------------------------------------------------------------------------
  // Setup wizard — every route returns 410 Gone once setup is complete
  // -------------------------------------------------------------------------
  'setup.status': {
    method: 'GET',
    path: '/setup/status',
    summary: 'Wizard progress. Reachable without a session so the UI can route to it.',
    auth: 'public',
    response: setupStatusSchema,
  },
  'setup.password': {
    method: 'POST',
    path: '/setup/password',
    summary: 'Set the initial admin password.',
    auth: 'public',
    body: setupPasswordRequestSchema,
    response: acknowledgedSchema,
    mutates: true,
  },
  'setup.complete': {
    method: 'POST',
    path: '/setup/complete',
    summary: 'Finish the wizard. Afterwards every /setup route returns 410 Gone.',
    auth: 'session',
    body: completeSetupRequestSchema,
    response: acknowledgedSchema,
    mutates: true,
  },
} as const satisfies Record<string, EndpointDefinition>;

// ---------------------------------------------------------------------------
// Inferred types — nothing below is hand-written
// ---------------------------------------------------------------------------

export type ApiContract = typeof apiContract;
export type EndpointId = keyof ApiContract;

type Def<K extends EndpointId> = ApiContract[K];

/** The request body a client sends. `z.input`, so fields with defaults stay optional. */
export type RequestBody<K extends EndpointId> =
  Def<K> extends { readonly body: infer B extends z.ZodTypeAny } ? z.input<B> : never;

export type RequestQuery<K extends EndpointId> =
  Def<K> extends { readonly query: infer Q extends z.ZodTypeAny } ? z.input<Q> : never;

export type PathParams<K extends EndpointId> =
  Def<K> extends { readonly params: infer P extends z.ZodTypeAny } ? z.input<P> : never;

/** The parsed `data` payload. `z.output`, because defaults are filled in by then. */
export type ResponseData<K extends EndpointId> = z.output<Def<K>['response']>;

/** The complete response body, envelope included. */
export type ResponseBody<K extends EndpointId> =
  { ok: true; data: ResponseData<K> } | z.infer<typeof apiErrorSchema>;

export type HasBody<K extends EndpointId> =
  Def<K> extends { readonly body: z.ZodTypeAny } ? true : false;
export type HasQuery<K extends EndpointId> =
  Def<K> extends { readonly query: z.ZodTypeAny } ? true : false;
export type HasParams<K extends EndpointId> =
  Def<K> extends { readonly params: z.ZodTypeAny } ? true : false;

export const ENDPOINT_IDS = Object.keys(apiContract) as EndpointId[];

/**
 * Substitutes path parameters and prefixes the API base path.
 * Values are URI-encoded, so a parameter can never inject an extra path segment.
 */
export const buildPath = (
  endpoint: EndpointId,
  params: Record<string, string | number> = {},
): string => {
  const template = apiContract[endpoint].path;
  const filled = template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for endpoint "${endpoint}"`);
    }
    return encodeURIComponent(String(value));
  });
  return `${API_BASE_PATH}${filled}`;
};

/** The success envelope schema for one endpoint, for use by the API middleware. */
export const responseEnvelopeSchema = <K extends EndpointId>(endpoint: K) =>
  apiSuccess(apiContract[endpoint].response);
