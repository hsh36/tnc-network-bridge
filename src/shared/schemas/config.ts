import { z } from 'zod';
import {
  cronSchema,
  globPatternSchema,
  interfaceNameSchema,
  ipAddressSchema,
  ipv4CidrSchema,
  ipv4Schema,
  percentSchema,
  secretWriteSchema,
} from './primitives';

/**
 * Typed views over the `config` table, one per section.
 *
 * Defaults mirror IMPLEMENTATION_PLAN §6 exactly — they are the values a fresh
 * install boots with. `/config/:section` is a full replace (GET then PUT), so every
 * field carries a default and no partial-update schema is needed.
 *
 * Secret fields use {@link secretWriteSchema}: reads emit the redaction sentinel and
 * writes accept it to mean "unchanged", so a client can round-trip a section it
 * fetched without ever handling the plaintext (T5).
 */

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

export const ipv4MethodSchema = z.enum(['dhcp', 'static']);

/**
 * One side of the bridge.
 *
 * The two sides are described by the same shape rather than by two hand-written ones.
 * They are not the same *kind* of network — one faces a corporate LAN, the other a
 * machine segment — but every knob an operator can turn applies to both, and a field
 * that existed on only one side was invariably an oversight rather than a decision:
 * before this, MTU and IPv6 were single global values and VLAN did not exist at all,
 * so a bridge whose two NICs needed different framing could not be expressed.
 */
export const networkSideSchema = z.object({
  interface: interfaceNameSchema,
  method: ipv4MethodSchema.default('dhcp'),
  /** Required when `method` is `static`; ignored by DHCP. */
  address: ipv4CidrSchema.optional(),
  gateway: ipv4Schema.optional(),
  /** Primary and secondary resolver, in that order. */
  dns: z.array(ipAddressSchema).max(2).default([]),
  /** 802.1Q tag, or `null` for untagged. */
  vlan: z.number().int().min(1).max(4094).nullable().default(null),
  mtu: z.number().int().min(576).max(9000).default(1500),
  ipv6: z.boolean().default(false),
});

export type NetworkSide = z.infer<typeof networkSideSchema>;

/** Adds the `static`-implies-address-and-gateway rule to one side. */
function checkStaticAddressing(
  side: NetworkSide,
  which: 'lan' | 'tnc',
  ctx: z.RefinementCtx,
): void {
  if (side.method !== 'static') {
    return;
  }
  if (side.address === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [which, 'address'],
      message: 'A static configuration requires an address',
    });
  }
  // The TNC side is a self-contained segment whose gateway *is* this bridge, so
  // demanding one there would be demanding the operator point it at itself.
  if (which === 'lan' && side.gateway === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [which, 'gateway'],
      message: 'A static LAN configuration requires a gateway',
    });
  }
}

export const networkConfigSchema = z
  .object({
    lan: networkSideSchema.extend({ interface: interfaceNameSchema.default('eth0') }).default({}),
    tnc: networkSideSchema
      .extend({
        interface: interfaceNameSchema.default('eth1'),
        method: ipv4MethodSchema.default('static'),
        /** The bridge's own address on the machine segment; also the TNC-side gateway. */
        address: ipv4CidrSchema.default('192.168.42.1/24'),
      })
      .default({}),
    /**
     * How long an unconfirmed change to the side the operator is connected over stays
     * in force before it is rolled back.
     *
     * Five minutes rather than the one that first suggests itself. The session cookie is
     * host-scoped, so a new address is a new origin: the operator has to find the new
     * URL, accept the self-signed certificate again, log in again, and only then can
     * confirm. A minute is not enough time to do that, and a window that expires while
     * they are still logging in reverts a change that was working.
     */
    applyRevertSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .superRefine((cfg, ctx) => {
    checkStaticAddressing(cfg.lan, 'lan', ctx);
    checkStaticAddressing(cfg.tnc, 'tnc', ctx);

    // Sharing a NIC is only safe when 802.1Q keeps the two segments in separate
    // broadcast domains. Untagged, it would put SMB1 on the corporate LAN — which is
    // the one outcome this product exists to prevent.
    if (cfg.lan.interface === cfg.tnc.interface) {
      const separated =
        cfg.lan.vlan !== null && cfg.tnc.vlan !== null && cfg.lan.vlan !== cfg.tnc.vlan;
      if (!separated) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tnc', 'interface'],
          message:
            'The LAN and TNC sides must not share an untagged interface. Give each side its own NIC, or a different VLAN id on this one.',
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// dhcp
// ---------------------------------------------------------------------------

/** `192.168.42.100-192.168.42.199` — the literal form dnsmasq consumes. */
export const dhcpRangeSchema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)-(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
    'Expected a range such as 192.168.42.100-192.168.42.199',
  );

/** dnsmasq duration: a count plus s/m/h/d, or `infinite`. */
export const dhcpLeaseTimeSchema = z
  .string()
  .regex(/^(?:\d+[smhd]|infinite)$/, 'Expected a lease time such as 12h, 30m or infinite');

/** Splits a validated range into its endpoints. */
export const parseDhcpRange = (range: string): { start: string; end: string } => {
  const [start = '', end = ''] = range.split('-');
  return { start, end };
};

export const dhcpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  range: dhcpRangeSchema.default('192.168.42.100-192.168.42.199'),
  leaseTime: dhcpLeaseTimeSchema.default('12h'),
  gateway: ipv4Schema.optional(),
});

// ---------------------------------------------------------------------------
// smb
// ---------------------------------------------------------------------------

/** Dialects Samba accepts on the modern (server-facing) side. */
export const serverProtocolSchema = z.enum(['SMB2', 'SMB3', 'SMB3_00', 'SMB3_02', 'SMB3_11']);

/** Dialects on the machine-facing side. NT1 is the whole reason this product exists. */
export const tncProtocolSchema = z.enum(['NT1', 'SMB2', 'SMB3']);

export const smbConfigSchema = z
  .object({
    server: z
      .object({
        minProtocol: serverProtocolSchema.default('SMB3_11'),
        /** SMB3 encryption on the LAN leg. */
        seal: z.boolean().default(true),
        credentials: z
          .object({
            domain: z.string().max(255).default(''),
            username: z.string().max(255).default(''),
            /** AES-256-GCM at rest; never returned in plaintext by the API. */
            password: secretWriteSchema.default(''),
          })
          .default({}),
      })
      .default({}),
    tnc: z
      .object({
        minProtocol: tncProtocolSchema.default('NT1'),
        maxProtocol: tncProtocolSchema.default('SMB3'),
        ntlmAuth: z.boolean().default(true),
        /** LANMAN is broken beyond repair; off unless a machine truly cannot do anything else. */
        lanmanAuth: z.boolean().default(false),
        dosCharset: z.string().max(32).default('CP850'),
        workgroup: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,15}$/, 'Invalid workgroup name')
          .default('WORKGROUP'),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    const order = ['NT1', 'SMB2', 'SMB3'] as const;
    if (order.indexOf(cfg.tnc.maxProtocol) < order.indexOf(cfg.tnc.minProtocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tnc', 'maxProtocol'],
        message: 'The maximum TNC protocol must not be lower than the minimum',
      });
    }
  });

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

export const conflictModeSchema = z.enum(['tnc_wins', 'server_wins', 'last_write_wins']);
export type ConflictMode = z.infer<typeof conflictModeSchema>;

// ---------------------------------------------------------------------------
// Advanced sync policies (T40)
// ---------------------------------------------------------------------------

/** `HH:MM`, 24-hour, in the host's local zone — the zone the operator's shift runs in. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Expected a 24-hour time such as "22:00"');

/** 0 = Sunday, matching `Date.getDay()`. */
export const weekdaySchema = z.number().int().min(0).max(6);

/**
 * A bandwidth ceiling that applies during a recurring daily window.
 *
 * `from`/`to` may wrap past midnight (`22:00`–`06:00`), which is the common case for a
 * night-shift allowance and the one a naive `from <= now && now < to` comparison gets
 * silently wrong.
 */
export const bandwidthWindowSchema = z
  .object({
    label: z.string().max(64).default(''),
    /** Days the window applies to. Empty means every day. */
    days: z.array(weekdaySchema).max(7).default([]),
    from: timeOfDaySchema,
    to: timeOfDaySchema,
    /** `null` means "no limit during this window" — an explicit override, not "unset". */
    limitKbps: z.number().int().positive().nullable(),
  })
  .strict();

export type BandwidthWindow = z.infer<typeof bandwidthWindowSchema>;

/**
 * A path rule. Exactly one of `glob` or `regex` — a rule that tried to be both would
 * have no defensible precedence between them.
 */
export const pathRuleSchema = z
  .object({
    glob: globPatternSchema.optional(),
    regex: z.string().max(512).optional(),
  })
  .strict()
  .refine(
    (rule) => (rule.glob === undefined) !== (rule.regex === undefined),
    'Give exactly one of "glob" or "regex"',
  );

export type PathRule = z.infer<typeof pathRuleSchema>;

/** A path rule carrying a priority. Lower sorts first, like `nice`. */
export const priorityRuleSchema = z
  .object({
    glob: globPatternSchema.optional(),
    regex: z.string().max(512).optional(),
    priority: z.number().int().min(0).max(1000).default(50),
  })
  .strict()
  .refine(
    (rule) => (rule.glob === undefined) !== (rule.regex === undefined),
    'Give exactly one of "glob" or "regex"',
  );

export type PriorityRule = z.infer<typeof priorityRuleSchema>;

export const syncPoliciesSchema = z.object({
  /**
   * Evaluated top to bottom, first match wins.
   *
   * Ordered rather than "most restrictive wins" so an operator can write a broad limit
   * and then an override above it ("unlimited 02:00–04:00 for the nightly bulk copy").
   * Most-restrictive-wins would make that override impossible to express.
   */
  bandwidthWindows: z.array(bandwidthWindowSchema).max(24).default([]),
  /** Files matching these sync before anything else. */
  priorityRules: z.array(priorityRuleSchema).max(50).default([]),
  /** Regex exclusions, complementing `sync.excludePatterns`' globs. */
  excludeRules: z.array(pathRuleSchema).max(50).default([]),
  /**
   * Paths that only ever travel server → TNC. A local edit to one of these is reverted
   * on the next pass rather than pushed, which is what makes a reference directory
   * genuinely read-only rather than merely conventionally so.
   */
  readOnlyRules: z.array(pathRuleSchema).max(50).default([]),
});

export type SyncPolicies = z.infer<typeof syncPoliciesSchema>;

export const syncConfigSchema = z.object({
  conflictMode: conflictModeSchema.default('last_write_wins'),
  /**
   * SMB and ext4 do not agree on timestamp granularity. Two mtimes within this window
   * are treated as equal by the diff engine (T18).
   */
  mtimeToleranceMs: z.number().int().min(0).max(60_000).default(2000),
  scanIntervalMs: z.number().int().min(1000).max(600_000).default(15_000),
  concurrency: z.number().int().min(1).max(32).default(4),
  bandwidthLimitKbps: z.number().int().positive().nullable().default(null),
  /** When set, a deletion is never propagated automatically — it is surfaced for review. */
  protectDeletes: z.boolean().default(true),
  excludePatterns: z
    .array(globPatternSchema)
    .max(200)
    .default(['**/.DS_Store', '**/Thumbs.db', '**/~$*', '**/.tnc-tmp-*']),
  /** Drop the TNC share to read-only when the server is unreachable (ARCHITECTURE §3.4). */
  failoverReadOnly: z.boolean().default(true),
  maxFileSizeMb: z.number().int().min(1).max(102_400).default(512),
  /** Time-aware throttling, priority and path rules (T40). Empty on a fresh install. */
  policies: syncPoliciesSchema.default({
    bandwidthWindows: [],
    priorityRules: [],
    excludeRules: [],
    readOnlyRules: [],
  }),
});

// ---------------------------------------------------------------------------
// locking
// ---------------------------------------------------------------------------

export const serverProjectionSchema = z.enum(['none', 'sidecar', 'byte_range']);

export const lockingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  serverProjection: serverProjectionSchema.default('sidecar'),
  /** Ceiling for a TNC that opens a file and never closes it. */
  tncLockTtlS: z.number().int().min(30).max(86_400).default(900),
  /** Grace period after `close` before the lock is released, to absorb save-close-reopen. */
  releaseLingerS: z.number().int().min(0).max(3600).default(5),
  /** Scheduled lock windows are off on a fresh install, per spec. */
  scheduleDefault: z.enum(['none', 'business_hours', 'custom']).default('none'),
  blockPullWhenLocked: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// versioning
// ---------------------------------------------------------------------------

export const versioningConfigSchema = z.object({
  enabled: z.boolean().default(true),
  keepCount: z.number().int().min(0).max(1000).default(20),
  keepDays: z.number().int().min(0).max(3650).default(90),
  maxStoreGb: z.number().min(0.1).max(1024).default(10),
});

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------

export const tlsVersionSchema = z.enum(['TLSv1.2', 'TLSv1.3']);
export type TlsVersion = z.infer<typeof tlsVersionSchema>;

export const securityConfigSchema = z.object({
  sessionIdleMin: z.number().int().min(1).max(1440).default(30),
  sessionAbsoluteH: z.number().int().min(1).max(168).default(12),
  loginMaxAttempts: z.number().int().min(1).max(100).default(5),
  fail2banEnabled: z.boolean().default(true),
  /** The spec calls for a default-accept firewall; rules are additive on top (T36). */
  firewallDefault: z.enum(['allow', 'deny']).default('allow'),
  tlsMin: tlsVersionSchema.default('TLSv1.2'),
});

// ---------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------

export const updateChannelSchema = z.enum(['stable', 'beta']);

export const updatesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  channel: updateChannelSchema.default('stable'),
  scheduleCron: cronSchema.default('0 3 * * 0'),
  autoRestart: z.boolean().default(true),
  githubRepo: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, 'Expected owner/repo')
    .default('hsh36/tnc-network-bridge'),
  rollbackOnFailure: z.boolean().default(true),
  /** How long `/health` gets to come back green before the release is rolled back (T43). */
  healthTimeoutS: z.number().int().min(10).max(900).default(120),
});

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const loggingConfigSchema = z.object({
  level: logLevelSchema.default('info'),
  retainDays: z.number().int().min(1).max(365).default(30),
});

// ---------------------------------------------------------------------------
// monitoring
// ---------------------------------------------------------------------------

export const monitoringConfigSchema = z.object({
  sampleIntervalS: z.number().int().min(1).max(3600).default(10),
  diskWarnPct: percentSchema.default(85),
});

// ---------------------------------------------------------------------------
// Section registry
// ---------------------------------------------------------------------------

/**
 * Every addressable `/config/:section`.
 *
 * IMPLEMENTATION_PLAN §5 lists eight sections while §6 also defines `locking.*` and
 * `monitoring.*` keys. Both are included here — otherwise lock TTLs and the disk
 * warning threshold would be defined but unreachable through the API.
 */
export const CONFIG_SECTION_NAMES = [
  'network',
  'dhcp',
  'smb',
  'sync',
  'locking',
  'versioning',
  'security',
  'updates',
  'logging',
  'monitoring',
] as const;

export const configSectionNameSchema = z.enum(CONFIG_SECTION_NAMES);
export type ConfigSectionName = z.infer<typeof configSectionNameSchema>;

export const configSectionSchemas = {
  network: networkConfigSchema,
  dhcp: dhcpConfigSchema,
  smb: smbConfigSchema,
  sync: syncConfigSchema,
  locking: lockingConfigSchema,
  versioning: versioningConfigSchema,
  security: securityConfigSchema,
  updates: updatesConfigSchema,
  logging: loggingConfigSchema,
  monitoring: monitoringConfigSchema,
} as const satisfies Record<ConfigSectionName, z.ZodTypeAny>;

/** The parsed shape of one section, e.g. `ConfigSection<'sync'>`. */
export type ConfigSection<K extends ConfigSectionName> = z.infer<(typeof configSectionSchemas)[K]>;

/** The whole configuration, section by section. */
export type FullConfig = { [K in ConfigSectionName]: ConfigSection<K> };

export type NetworkConfig = ConfigSection<'network'>;
export type DhcpConfig = ConfigSection<'dhcp'>;
export type SmbConfig = ConfigSection<'smb'>;
export type SyncConfig = ConfigSection<'sync'>;
export type LockingConfig = ConfigSection<'locking'>;
export type VersioningConfig = ConfigSection<'versioning'>;
export type SecurityConfig = ConfigSection<'security'>;
export type UpdatesConfig = ConfigSection<'updates'>;
export type LoggingConfig = ConfigSection<'logging'>;
export type MonitoringConfig = ConfigSection<'monitoring'>;

/**
 * Dotted config keys whose stored value is an encrypted envelope.
 * The redaction layer (T5) and the log redactor (T6) both read this list.
 */
export const SECRET_CONFIG_KEYS = ['smb.server.credentials.password'] as const;
export type SecretConfigKey = (typeof SECRET_CONFIG_KEYS)[number];
