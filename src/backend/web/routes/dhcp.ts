import { Router } from 'express';
import { z } from 'zod';
import { macAddressSchema, ipv4Schema } from '../../../shared';
import { DHCPConfigManager } from '../dhcp/dhcp-config-manager';
import { rateLimit } from '../security/rate-limit';
import { type AppContext } from '../context';
import { ok, requireCsrf, requireSession } from './middleware';

/**
 * `/dhcp/*` routes for DHCP server management (T35).
 *
 * Manages the dnsmasq configuration and discovers machines on the TNC network.
 */

export function dhcpRoutes(ctx: AppContext): Router {
  const router = Router();
  const manager = new DHCPConfigManager({
    db: ctx.db,
    config: ctx.config,
    logger: ctx.logger,
  });

  // Rate-limit configuration changes
  const limitWrites = rateLimit({
    limit: 10,
    windowMs: 60_000,
    onDenied: (key, req) => {
      ctx.audit?.recordDenied({
        actor: key,
        action: 'dhcp.update',
        target: req.path,
        detail: 'rate limit exceeded',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });
    },
  });

  /**
   * GET /dhcp/config
   *
   * Returns the current DHCP configuration (from the `dhcp` config section).
   */
  router.get('/dhcp/config', requireSession(ctx), (req, res) => {
    const config = ctx.config.get('dhcp');
    ok(res, config);
  });

  /**
   * PUT /dhcp/config
   *
   * Updates the DHCP configuration. Applies validation from the dhcpConfigSchema.
   */
  router.put('/dhcp/config', requireSession(ctx), requireCsrf(ctx), limitWrites, (req, res) => {
    const updated = ctx.config.set('dhcp', req.body, 'admin');

    ctx.audit?.record({
      actor: 'admin',
      action: 'dhcp.config.update',
      target: 'dhcp',
      result: 'ok',
      ...(req.ip !== undefined ? { ip: req.ip } : {}),
    });

    ok(res, updated);
  });

  /**
   * GET /dhcp/machines
   *
   * Returns discovered machines from the TNC network, derived from:
   * - DHCP leases (via dnsmasq)
   * - Static reservations (from tnc_clients table)
   * - SMB sessions (future integration with T13)
   */
  router.get('/dhcp/machines', requireSession(ctx), async (req, res, next) => {
    try {
      const leases = await manager.parseLeaseFile();
      const discovered = manager.getDiscoveredMachines();

      // Merge leases and discovered machines, preferring discovered for richer data
      const machineMap = new Map<string, (typeof discovered)[0]>();
      for (const machine of discovered) {
        machineMap.set(machine.mac, machine);
      }

      // Add or update from leases
      for (const lease of leases) {
        if (!machineMap.has(lease.mac)) {
          machineMap.set(lease.mac, {
            mac: lease.mac,
            ip: lease.ip,
            hostname: lease.hostname,
            lastSeen: lease.timestamp,
            isOnline: true,
          });
        } else {
          const existing = machineMap.get(lease.mac)!;
          machineMap.set(lease.mac, {
            ...existing,
            ip: lease.ip,
            lastSeen: Math.max(existing.lastSeen, lease.timestamp),
            isOnline: true,
          });
        }
      }

      ok(res, {
        machines: Array.from(machineMap.values()),
        count: machineMap.size,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /dhcp/leases
   *
   * Returns current DHCP leases (parsed from dnsmasq.leases file).
   */
  router.get('/dhcp/leases', requireSession(ctx), async (req, res, next) => {
    try {
      const leases = await manager.parseLeaseFile();
      ok(res, {
        leases: leases.map((lease) => ({
          mac: lease.mac,
          ip: lease.ip,
          hostname: lease.hostname,
          timestamp: lease.timestamp,
        })),
        count: leases.length,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /dhcp/reserve
   *
   * Adds or updates a static DHCP reservation.
   *
   * Request body:
   *   - mac: MAC address (required)
   *   - ip: IPv4 address to reserve (required)
   *   - hostname: optional hostname for the reservation
   */
  router.post(
    '/dhcp/reserve',
    requireSession(ctx),
    requireCsrf(ctx),
    limitWrites,
    (req, res, next) => {
      try {
        const schema = z.object({
          mac: macAddressSchema,
          ip: ipv4Schema,
          hostname: z.string().max(255).optional(),
        });

        const { mac, ip, hostname } = schema.parse(req.body);
        const now = Math.floor(Date.now() / 1000);

        ctx.db.transaction(() => {
          // Check if this MAC already exists
          const existing = ctx.db.get<{ id: number }>(
            `SELECT id FROM tnc_clients WHERE mac_address = @mac`,
            { mac },
          );

          if (existing) {
            // Update existing reservation
            ctx.db.run(
              `UPDATE tnc_clients
             SET reserved_ip = @ip, name = @hostname, dhcp_reserved = 1, updated_at = @now
             WHERE mac_address = @mac`,
              {
                mac,
                ip,
                hostname: hostname || mac,
                now,
              },
            );
          } else {
            // Create new reservation
            ctx.db.run(
              `INSERT INTO tnc_clients (mac_address, reserved_ip, name, dhcp_reserved, created_at, updated_at)
             VALUES (@mac, @ip, @hostname, 1, @now, @now)`,
              {
                mac,
                ip,
                hostname: hostname || mac,
                now,
              },
            );
          }
        });

        ctx.audit?.record({
          actor: 'admin',
          action: 'dhcp.reserve',
          target: mac,
          detail: `reserved ${ip}`,
          result: 'ok',
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
        });

        ok(res, { mac, ip, hostname, reserved: true });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * DELETE /dhcp/reserve/:mac
   *
   * Removes a static DHCP reservation (clears the reserved_ip).
   */
  router.delete(
    '/dhcp/reserve/:mac',
    requireSession(ctx),
    requireCsrf(ctx),
    limitWrites,
    (req, res, next) => {
      try {
        const mac = macAddressSchema.parse(req.params.mac);

        ctx.db.run(
          `UPDATE tnc_clients
         SET reserved_ip = NULL, dhcp_reserved = 0, updated_at = @now
         WHERE mac_address = @mac`,
          {
            mac,
            now: Math.floor(Date.now() / 1000),
          },
        );

        ctx.audit?.record({
          actor: 'admin',
          action: 'dhcp.unreserve',
          target: mac,
          result: 'ok',
          ...(req.ip !== undefined ? { ip: req.ip } : {}),
        });

        ok(res, { mac, reserved: false });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
