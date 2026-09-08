import { statfsSync } from 'node:fs';
import { freemem, hostname, loadavg, networkInterfaces, release, totalmem, uptime } from 'node:os';
import { Router } from 'express';
import { type NetworkInterface, type SystemInfo } from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

function readDisk(mountPoint: string): SystemInfo['disks'][number] | undefined {
  try {
    const stats = statfsSync(mountPoint);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      mountPoint,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return undefined;
  }
}

function collectInterfaces(lan?: string, tnc?: string): NetworkInterface[] {
  const result: NetworkInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (addresses === undefined || addresses.length === 0) {
      continue;
    }
    const first = addresses[0];
    result.push({
      name,
      mac: first?.mac !== undefined && first.mac !== '00:00:00:00:00:00' ? first.mac : null,
      addresses: addresses.map((a) => a.address),
      up: !addresses.every((a) => a.internal),
      speedMbps: null,
      mtu: 1500,
      role: name === lan ? 'lan' : name === tnc ? 'tnc' : 'other',
      rxBytes: 0,
      txBytes: 0,
    });
  }
  return result;
}

/** `/system` (T30) — host facts drawn straight from `node:os`, no privileged helper involved. */
export function systemRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/system', requireSessionOrToken(ctx), (_req, res) => {
    const network = ctx.config.get('network');
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const usedBytes = totalBytes - freeBytes;
    const disks = [readDisk('/')].filter((d): d is SystemInfo['disks'][number] => d !== undefined);
    const [one = 0, five = 0, fifteen = 0] = loadavg();

    const info: SystemInfo = {
      hostname: hostname(),
      version: ctx.version,
      nodeVersion: process.version,
      osRelease: release(),
      uptimeSeconds: Math.floor(uptime()),
      loadAverage: [one, five, fifteen],
      memory: {
        totalBytes,
        usedBytes,
        usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      },
      cpuTempC: null,
      throttling: {
        underVoltageNow: false,
        underVoltageOccurred: false,
        frequencyCappedNow: false,
        throttledNow: false,
        throttledOccurred: false,
      },
      disks,
      interfaces: collectInterfaces(network.lan.interface, network.tnc.interface),
    };
    ok(res, info);
  });

  return router;
}
