import { type PrtgChannel, type PrtgResponse } from '../../shared';
import { type BridgeMetrics } from './registry';

/**
 * The PRTG "HTTP Data Advanced" payload (T41).
 *
 * PRTG is unusually strict about this shape, and the constraints are not obvious from
 * its documentation:
 *
 * - **Limit fields must be strings**, even though they hold numbers. A numeric
 *   `limitmaxwarning` is silently ignored, so the sensor simply never alerts — the worst
 *   possible failure for a monitoring integration, because everything looks healthy.
 * - **A channel's unit is fixed for the life of the sensor.** Changing one later makes
 *   PRTG discard the channel's history rather than convert it, so the units here are
 *   chosen once and treated as a compatibility surface.
 * - `float: 1` is required for any non-integer value; without it PRTG truncates.
 * - The response is **not** wrapped in the API's usual envelope. PRTG parses the
 *   top-level object and fails on anything else.
 *
 * Channels are limited to what an operator would actually alert on. A PRTG sensor with
 * fifty channels is unreadable, and every channel added is one more thing whose unit can
 * never change.
 */

export interface PrtgOptions {
  readonly metrics: BridgeMetrics;
  /** Disk warning threshold in percent, from the `monitoring` config section. */
  readonly diskWarnPct: number;
  /** Set when the bridge is degraded; PRTG shows it as the sensor message. */
  readonly statusText?: string;
  /** Marks the whole sensor as down, e.g. when the server link is lost. */
  readonly error?: boolean;
}

/** Numbers cross into PRTG as strings for limits, and as floats where fractional. */
const limit = (value: number): string => String(value);

export function buildPrtgResponse(options: PrtgOptions): PrtgResponse {
  const { metrics } = options;

  const diskUsed = metrics.diskUsage.get();
  const diskFree = metrics.diskFree.get();
  const diskTotal = diskUsed + diskFree;
  const diskUsedPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

  const channels: PrtgChannel[] = [
    {
      channel: 'Disk usage',
      value: Number(diskUsedPct.toFixed(2)),
      unit: 'Percent',
      float: 1,
      limitmode: 1,
      limitmaxwarning: limit(options.diskWarnPct),
      // Hard-stop headroom: past this the sync engine refuses new versions, so an
      // operator needs to know before it happens rather than when writes start failing.
      limitmaxerror: limit(95),
      limitwarningmsg: 'The local cache is filling up',
      limiterrormsg: 'The local cache is nearly full — sync will go read-only',
    },
    {
      channel: 'Free disk space',
      value: diskFree,
      unit: 'BytesDisk',
      float: 0,
    },
    {
      channel: 'Active locks',
      value: metrics.locks.get(),
      unit: 'Count',
      float: 0,
    },
    {
      channel: 'Queue depth',
      value: metrics.queueDepth.get(),
      unit: 'Count',
      float: 0,
      limitmode: 1,
      // A queue that stays deep means the bridge is not keeping up with the machines.
      limitmaxwarning: limit(100),
      limitwarningmsg: 'Transfers are backing up',
    },
    {
      channel: 'Files synced',
      value: metrics.syncFiles.get(),
      unit: 'Count',
      // Difference mode: PRTG graphs the per-interval delta of this counter, which is
      // the rate an operator wants. Absolute would draw an ever-climbing line.
      mode: 'Difference',
      float: 0,
    },
    {
      channel: 'Errors',
      value: metrics.errors.get(),
      unit: 'Count',
      mode: 'Difference',
      float: 0,
      limitmode: 1,
      limitmaxwarning: limit(1),
      limitmaxerror: limit(10),
      limitwarningmsg: 'Sync errors are occurring',
      limiterrormsg: 'Sync is failing repeatedly',
    },
    {
      channel: 'Throughput',
      value: Number(metrics.throughput.get().toFixed(0)),
      customunit: 'B/s',
      float: 0,
    },
    {
      channel: 'Shares online',
      value: metrics.sharesOnline.get(),
      unit: 'Count',
      float: 0,
    },
    {
      channel: 'Version store',
      value: metrics.versionBytes.get(),
      unit: 'BytesDisk',
      float: 0,
    },
    {
      channel: 'Uptime',
      value: metrics.uptime.get(),
      unit: 'TimeSeconds',
      float: 0,
    },
  ];

  return {
    prtg: {
      result: channels,
      ...(options.statusText !== undefined ? { text: options.statusText } : {}),
      ...(options.error === true ? { error: 1 as const } : {}),
    },
  };
}
