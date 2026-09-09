import { networkInterfaces } from 'node:os';

import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { type AppContext } from './context';
import { HttpError } from './envelope';

/**
 * Refuses any request that arrived on the TNC side.
 *
 * The nftables ruleset in `security/firewall.ts` is what actually keeps the machine
 * segment away from the management interface; this is the backstop for when it is not
 * in force — a flushed ruleset while debugging something else, a boot where `nft`
 * failed, an operator who replaced the table by hand. None of those should quietly turn
 * an unreachable admin UI into a reachable one.
 *
 * The test is on `socket.localAddress`: the address this connection was *accepted* on.
 * That is the local end of an established TCP connection, so unlike a source address or
 * a header it cannot be claimed by the peer. Matching on the address rather than on the
 * configured subnet also means it stays correct when the TNC side runs DHCP, or when
 * both sides share one NIC through tagged VLANs.
 */

/** IPv4-mapped IPv6, as Node reports it on a dual-stack listener: `::ffff:192.168.42.1`. */
function normalise(address: string | undefined): string | undefined {
  if (address === undefined) {
    return undefined;
  }
  const lower = address.toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

/**
 * Every address currently held by `iface`.
 *
 * Read live rather than cached: `apply-network` changes addresses underneath a running
 * process, and a guard working from a startup snapshot would either start refusing LAN
 * requests or stop refusing TNC ones the moment it did.
 */
export function addressesOf(
  iface: string,
  read: typeof networkInterfaces = networkInterfaces,
): Set<string> {
  const found = new Set<string>();
  for (const entry of read()[iface] ?? []) {
    const normalised = normalise(entry.address);
    if (normalised !== undefined) {
      found.add(normalised);
    }
  }
  return found;
}

export interface ManagementGuardOptions {
  /** Injectable for tests; defaults to the real `os.networkInterfaces`. */
  readonly read?: typeof networkInterfaces;
}

export function managementGuard(
  ctx: AppContext,
  options: ManagementGuardOptions = {},
): RequestHandler {
  const read = options.read ?? networkInterfaces;

  return (req: Request, _res: Response, next: NextFunction): void => {
    const local = normalise(req.socket.localAddress);
    if (local === undefined) {
      // No local address means no socket to judge — a unit test calling the handler
      // directly. Refusing here would break nothing real and block every such test.
      next();
      return;
    }

    const tncInterface = ctx.config.get('network').tnc.interface;
    if (!addressesOf(tncInterface, read).has(local)) {
      next();
      return;
    }

    ctx.audit?.recordDenied({
      actor: 'unknown',
      action: 'management.access',
      target: `${req.method} ${req.path}`,
      detail: `request arrived on ${tncInterface} (${local}); management is LAN-only`,
      ...(req.ip === undefined ? {} : { ip: req.ip }),
    });

    // 403 rather than 404: the operator debugging this needs to be told the rule
    // exists. Anyone on the TNC segment should never get this far — the firewall drops
    // the packet — so reaching it at all is itself worth the audit entry above.
    next(
      new HttpError(
        403,
        'FORBIDDEN',
        'This appliance is managed from the LAN only. The TNC interface serves files, not configuration.',
      ),
    );
  };
}
