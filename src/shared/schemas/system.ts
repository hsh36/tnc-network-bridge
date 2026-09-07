import { z } from 'zod';
import { shareRuntimeSchema } from './share';
import {
  entityIdSchema,
  interfaceNameSchema,
  ipAddressSchema,
  macAddressSchema,
  percentSchema,
  unixSecondsSchema,
} from './primitives';

// ---------------------------------------------------------------------------
// /health — unauthenticated, localhost only
// ---------------------------------------------------------------------------

/**
 * Consumed by the systemd watchdog and, critically, by the update health gate: a
 * release that cannot turn this green within the timeout is rolled back (T43).
 * Deliberately cheap and dependency-light.
 */
export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'starting', 'stopping']),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  checks: z.object({
    database: z.boolean(),
    migrations: z.boolean(),
    httpServer: z.boolean(),
    samba: z.boolean(),
  }),
});

export type Health = z.infer<typeof healthSchema>;

// ---------------------------------------------------------------------------
// /status — the dashboard aggregate
// ---------------------------------------------------------------------------

export const serverLinkSchema = z.object({
  reachable: z.boolean(),
  /** Negotiated dialect on the LAN leg, when a mount is established. */
  dialect: z.string().nullable(),
  signing: z.boolean().nullable(),
  encryption: z.boolean().nullable(),
  lastProbeAt: unixSecondsSchema.nullable(),
  lastError: z.string().nullable(),
});

export const statusSchema = z.object({
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  /** True while the setup wizard has not been completed. */
  setupRequired: z.boolean(),
  serverLink: serverLinkSchema,
  shares: z.array(shareRuntimeSchema),
  totals: z.object({
    sharesEnabled: z.number().int().nonnegative(),
    filesIndexed: z.number().int().nonnegative(),
    filesPending: z.number().int().nonnegative(),
    activeLocks: z.number().int().nonnegative(),
    unacknowledgedConflicts: z.number().int().nonnegative(),
    bytesInPerSec: z.number().nonnegative(),
    bytesOutPerSec: z.number().nonnegative(),
  }),
  /** Set when the failover controller has forced read-only anywhere (T23). */
  readOnlyReason: z.string().nullable(),
});

export type Status = z.infer<typeof statusSchema>;

// ---------------------------------------------------------------------------
// /system — host facts
// ---------------------------------------------------------------------------

export const networkInterfaceSchema = z.object({
  name: interfaceNameSchema,
  mac: macAddressSchema.nullable(),
  addresses: z.array(ipAddressSchema),
  up: z.boolean(),
  /** Link speed in Mbit/s from /sys/class/net, when the driver reports it. */
  speedMbps: z.number().int().positive().nullable(),
  mtu: z.number().int().positive(),
  /** Which leg of the bridge this interface serves, if any. */
  role: z.enum(['lan', 'tnc', 'other']),
  rxBytes: z.number().nonnegative(),
  txBytes: z.number().nonnegative(),
});

export type NetworkInterface = z.infer<typeof networkInterfaceSchema>;

export const diskUsageSchema = z.object({
  mountPoint: z.string(),
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  usedPct: percentSchema,
});

export const systemInfoSchema = z.object({
  hostname: z.string(),
  version: z.string(),
  nodeVersion: z.string(),
  osRelease: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  memory: z.object({
    totalBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    usedPct: percentSchema,
  }),
  /** SoC temperature in °C. */
  cpuTempC: z.number().nullable(),
  /**
   * Raspberry Pi throttling bits from `vcgencmd get_throttled`. Under-voltage on a Pi
   * corrupts SD cards and stalls I/O, so it is surfaced rather than buried.
   */
  throttling: z.object({
    underVoltageNow: z.boolean(),
    underVoltageOccurred: z.boolean(),
    frequencyCappedNow: z.boolean(),
    throttledNow: z.boolean(),
    throttledOccurred: z.boolean(),
  }),
  disks: z.array(diskUsageSchema),
  interfaces: z.array(networkInterfaceSchema),
});

export type SystemInfo = z.infer<typeof systemInfoSchema>;

// ---------------------------------------------------------------------------
// Discovered TNC machines
// ---------------------------------------------------------------------------

export const tncModelSchema = z.enum(['iTNC530', 'TNC620', 'TNC640', 'other']);

export const tncClientSchema = z.object({
  id: entityIdSchema,
  name: z.string().nullable(),
  mac: macAddressSchema.nullable(),
  ip: ipAddressSchema.nullable(),
  model: tncModelSchema.nullable(),
  /** Whether a DHCP reservation pins this machine to its address (T35). */
  dhcpStatic: z.boolean(),
  firstSeenAt: unixSecondsSchema.nullable(),
  lastSeenAt: unixSecondsSchema.nullable(),
  notes: z.string().nullable(),
});

export type TncClient = z.infer<typeof tncClientSchema>;

export const updateTncClientRequestSchema = z
  .object({
    name: z.string().max(64).nullable(),
    model: tncModelSchema.nullable(),
    ip: ipAddressSchema.nullable(),
    dhcpStatic: z.boolean(),
    notes: z.string().max(1000).nullable(),
  })
  .partial()
  .strict();

export const restartTargetSchema = z.enum(['restart-service', 'reboot']);
