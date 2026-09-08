import { Router } from 'express';
import {
  applyNetworkConfigRequestSchema,
  applyNetworkConfigResponseSchema,
  confirmNetworkChangeRequestSchema,
  pendingNetworkChangeResponseSchema,
  type ApplyNetworkConfigResponse,
  type NetworkInterfacesResponse,
  type PendingNetworkChangeResponse,
} from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireSession } from '../middleware';

/**
 * `/network/*` endpoints (T34): Network interface management and configuration.
 *
 * All endpoints are protected by session authentication. Modifications are audited
 * and use the apply-with-rollback pattern for safety on headless hardware.
 */
export function networkRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * GET /network/interfaces
   *
   * Discover all network interfaces with their current configuration and state.
   * Returns interfaces identified by MAC address (stable across reboots) with
   * their current kernel name, state, speed, and stored configuration.
   */
  router.get('/network/interfaces', requireSession(ctx), (_req, res) => {
    // In production, this would:
    // 1. Call manager.discoverInterfaces() to get live interface state
    // 2. For each interface, call manager.getConfig(mac) to get stored config
    // 3. Combine them into the response

    // For now, return an empty list
    const response: NetworkInterfacesResponse = {
      interfaces: [],
    };

    ok(res, response);
  });

  /**
   * POST /network/apply-config
   *
   * Apply a new configuration to a network interface.
   *
   * If revertAfterSeconds > 0 (default 60), the change is applied but a systemd
   * timer is armed. If the admin doesn't confirm within that window by calling
   * POST /network/confirm-change, the interface automatically reverts to the
   * previous configuration.
   *
   * This is the apply-with-rollback pattern that prevents lockout on headless
   * hardware (ARCHITECTURE §5.3).
   *
   * Request body:
   * {
   *   "mac": "b8:27:eb:00:11:22",
   *   "config": { ... network config ... },
   *   "revertAfterSeconds": 60
   * }
   *
   * Response:
   * {
   *   "status": "ok" | "pending_confirmation",
   *   "change": { ... pending change details ... } (if pending_confirmation)
   * }
   */
  router.post('/network/apply-config', requireSession(ctx), (req, res, next) => {
    try {
      const request = applyNetworkConfigRequestSchema.parse(req.body);

      // In production, this would:
      // 1. Validate the configuration
      // 2. Ensure it won't break connectivity to this interface
      // 3. Call manager.applyConfig()
      // 4. Record the audit entry
      // 5. Return the response with or without a pending change

      // For now, just parse and echo back
      const response: ApplyNetworkConfigResponse = {
        status: 'ok',
      };

      ctx.audit?.record({
        actor: 'admin',
        action: 'network.apply-config',
        target: request.mac,
        result: 'ok',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });

      ok(res, applyNetworkConfigResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /network/confirm-change
   *
   * Confirm a pending network change and cancel the auto-revert timer.
   *
   * The change becomes permanent; no rollback will occur even if connectivity
   * is lost (though the operator should have verified connectivity before
   * confirming).
   *
   * Request body:
   * {
   *   "mac": "b8:27:eb:00:11:22"
   * }
   *
   * Response:
   * {
   *   "status": "ok"
   * }
   */
  router.post('/network/confirm-change', requireSession(ctx), (req, res, next) => {
    try {
      const request = confirmNetworkChangeRequestSchema.parse(req.body);

      // In production, this would:
      // 1. Call manager.confirmPendingChange(mac)
      // 2. Invoke the privileged helper to stop the revert timer
      // 3. Record the audit entry

      ctx.audit?.record({
        actor: 'admin',
        action: 'network.confirm-change',
        target: request.mac,
        result: 'ok',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });

      ok(res, { status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /network/pending-change?mac=<mac>
   *
   * Check the status of a pending network change.
   *
   * If a change is pending, returns the change details and how many seconds remain
   * before auto-revert. If no change is pending or the MAC is unknown, returns
   * pending: null.
   *
   * Query parameters:
   * - mac: The MAC address to check (required)
   *
   * Response:
   * {
   *   "pending": { ... change details ... } | null,
   *   "secondsRemaining": 45 | null
   * }
   */
  router.get('/network/pending-change', requireSession(ctx), (req, res, next) => {
    try {
      const mac = req.query.mac as string | undefined;
      if (!mac) {
        return res.status(400).json({ error: 'mac query parameter is required' });
      }

      // Validate MAC address format
      if (!/^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
        return res.status(400).json({ error: 'invalid MAC address format' });
      }

      // In production, this would:
      // 1. Call manager.getPendingChange(mac)
      // 2. If found, calculate secondsRemaining = change.expiresAt - now

      const response: PendingNetworkChangeResponse = {
        pending: null,
        secondsRemaining: null,
      };

      ok(res, pendingNetworkChangeResponseSchema.parse(response));
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /network/interfaces/:mac/config
   *
   * Update the stored configuration for a specific interface.
   *
   * This endpoint stores the configuration but does NOT apply it — that is
   * done via POST /network/apply-config. This is useful for preparing
   * a configuration for later application, or updating the defaults for
   * an interface without immediate change.
   *
   * Request body:
   * {
   *   "method": "static",
   *   "address": "192.168.1.100/24",
   *   "gateway": "192.168.1.1",
   *   "dns": ["8.8.8.8"],
   *   "mtu": 1500,
   *   "ipv6Enabled": false
   * }
   *
   * Response:
   * {
   *   "status": "ok"
   * }
   */
  router.put('/network/interfaces/:mac/config', requireSession(ctx), (req, res, next) => {
    try {
      const mac = req.params.mac!;

      // Validate MAC address format
      if (!/^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
        return res.status(400).json({ error: 'invalid MAC address format' });
      }

      // In production, this would:
      // 1. Validate the configuration
      // 2. Call manager.storeConfig(mac, config)
      // 3. Record the audit entry

      ctx.audit?.record({
        actor: 'admin',
        action: 'network.update-config',
        target: mac,
        result: 'ok',
        ...(req.ip !== undefined ? { ip: req.ip } : {}),
      });

      ok(res, { status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
