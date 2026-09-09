import { z } from 'zod';
import {
  interfaceNameSchema,
  ipAddressSchema,
  ipv4CidrSchema,
  ipv4Schema,
  macAddressSchema,
  unixSecondsSchema,
} from './primitives';
import { ipv4MethodSchema } from './config';

/**
 * Network-related schemas for T34: Network configuration manager.
 *
 * Tracks interfaces by MAC address (not kernel names) to ensure stability across
 * reboots regardless of enumeration order. The privileged helper works with kernel
 * interface names at the boundary, but the manager translates to MAC-based persistence.
 */

// ---------------------------------------------------------------------------
// Interface discovery and state
// ---------------------------------------------------------------------------

/**
 * A discovered network interface with complete current state.
 *
 * MAC address is the stable identifier. All other properties are transient,
 * read from the kernel and nmcli at the time of discovery.
 */
export const interfaceDiscoverySchema = z.object({
  /** Stable identifier: MAC address. Never changes. */
  mac: macAddressSchema,
  /** Kernel interface name: may change across reboots. */
  name: interfaceNameSchema,
  /** Administrative state. */
  state: z.enum(['up', 'down', 'unknown']),
  /** Link speed in Mbit/s, null if not reported by the driver. */
  speedMbps: z.number().int().positive().nullable(),
  /** Network driver name. */
  driver: z.string().nullable(),
  /** Has an active IP address. */
  hasAddress: z.boolean(),
});

export type InterfaceDiscovery = z.infer<typeof interfaceDiscoverySchema>;

// ---------------------------------------------------------------------------
// Network configuration (runtime state + applied settings)
// ---------------------------------------------------------------------------

/** Imported from config.ts to avoid duplication. */
export type IPv4Method = z.infer<typeof ipv4MethodSchema>;

/**
 * The complete network configuration for one interface.
 *
 * This is what the backend wants to apply/persist: the desired state of an
 * interface, independent of its kernel name.
 */
export const interfaceNetworkConfigSchema = z
  .object({
    /** IPv4 configuration method. */
    method: ipv4MethodSchema,
    /** Static IPv4 address with prefix, required if method is 'static'. */
    address: ipv4CidrSchema.optional(),
    /** Default gateway for this interface. Required if method is 'static'. */
    gateway: ipv4Schema.optional(),
    /** DNS servers (up to 3). */
    dns: z.array(ipAddressSchema).max(3),
    /** MTU in bytes. */
    mtu: z.number().int().min(576).max(9000),
    /** Whether to enable IPv6 on this interface. */
    ipv6Enabled: z.boolean(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.method === 'static' && cfg.address === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['address'],
        message: 'Static method requires an address',
      });
    }
    if (cfg.method === 'static' && cfg.gateway === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gateway'],
        message: 'Static method requires a gateway',
      });
    }
  });

export type InterfaceNetworkConfig = z.infer<typeof interfaceNetworkConfigSchema>;

/**
 * Defaults for a new interface configuration.
 *
 * Used as a factory function to initialize config for interfaces without
 * prior configuration.
 */
export const defaultInterfaceNetworkConfig = (): InterfaceNetworkConfig => ({
  method: 'dhcp',
  dns: [],
  mtu: 1500,
  ipv6Enabled: false,
});

// ---------------------------------------------------------------------------
// Pending changes with rollback tracking
// ---------------------------------------------------------------------------

/**
 * A network change awaiting confirmation.
 *
 * When a configuration is applied with revertAfterSeconds > 0, a PendingChange
 * record is created. If the admin doesn't confirm within the window, the
 * privileged helper's systemd timer reverts the change. Confirming involves
 * calling the apply endpoint again with revertAfterSeconds: 0, which cancels
 * the timer.
 */
export const pendingChangeSchema = z.object({
  /** Which interface this change applies to. */
  mac: macAddressSchema,
  /** The configuration that was in effect before the change. */
  oldConfig: interfaceNetworkConfigSchema,
  /** The configuration applied and awaiting confirmation. */
  newConfig: interfaceNetworkConfigSchema,
  /** When the timer expires and the change is automatically reverted. */
  expiresAt: unixSecondsSchema,
});

export type PendingChange = z.infer<typeof pendingChangeSchema>;

// ---------------------------------------------------------------------------
// API request/response bodies
// ---------------------------------------------------------------------------

/**
 * Request to apply a new network configuration.
 *
 * The client sends the new config they want; the backend translates the MAC
 * to a kernel interface name and sends a request to the privileged helper.
 */
export const applyNetworkConfigRequestSchema = z.object({
  mac: macAddressSchema,
  config: interfaceNetworkConfigSchema,
  /** How long to wait for confirmation before auto-reverting. 0 to confirm immediately. */
  revertAfterSeconds: z.number().int().min(0).max(3600).default(60),
});

export type ApplyNetworkConfigRequest = z.infer<typeof applyNetworkConfigRequestSchema>;

/**
 * Response when a configuration is applied with a rollback countdown.
 */
export const applyNetworkConfigResponseSchema = z.object({
  status: z.enum(['ok', 'pending_confirmation']),
  /** When using pending_confirmation, the change details. */
  change: pendingChangeSchema.optional(),
});

export type ApplyNetworkConfigResponse = z.infer<typeof applyNetworkConfigResponseSchema>;

/**
 * Request to confirm a pending change (cancel the auto-revert timer).
 */
export const confirmNetworkChangeRequestSchema = z.object({
  mac: macAddressSchema,
});

export type ConfirmNetworkChangeRequest = z.infer<typeof confirmNetworkChangeRequestSchema>;

/**
 * Response containing the current state of a pending change.
 */
export const pendingNetworkChangeResponseSchema = z.object({
  pending: pendingChangeSchema.nullable(),
  /** Seconds remaining until auto-revert. */
  secondsRemaining: z.number().int().nonnegative().nullable(),
});

export type PendingNetworkChangeResponse = z.infer<typeof pendingNetworkChangeResponseSchema>;

/**
 * GET /network/interfaces response: discovered interfaces with their current config.
 */
export const networkInterfacesResponseSchema = z.object({
  interfaces: z.array(
    z.object({
      discovery: interfaceDiscoverySchema,
      config: interfaceNetworkConfigSchema,
    }),
  ),
});

export type NetworkInterfacesResponse = z.infer<typeof networkInterfacesResponseSchema>;

// ---------------------------------------------------------------------------
// Applying a saved side (see backend/network/apply-service.ts)
// ---------------------------------------------------------------------------

export const networkSideNameSchema = z.enum(['lan', 'tnc']);

/**
 * Which side to apply or confirm.
 *
 * Side rather than MAC: the MAC is the right storage key because it survives a NIC
 * being renamed, but an operator knows which cable goes where, not which card holds
 * which address.
 */
export const applyNetworkSideRequestSchema = z.object({ side: networkSideNameSchema }).strict();
export type ApplyNetworkSideRequest = z.infer<typeof applyNetworkSideRequestSchema>;

export const applyNetworkSideResponseSchema = z.object({
  side: networkSideNameSchema,
  interface: interfaceNameSchema,
  /** `applied` when this connection was never at risk; otherwise a timer is running. */
  status: z.enum(['applied', 'pending_confirmation']),
  expiresAt: unixSecondsSchema.nullable(),
  /** Where to look for the interface afterwards, when a static address makes that knowable. */
  expectedUrl: z.string().nullable(),
});
export type ApplyNetworkSideResponse = z.infer<typeof applyNetworkSideResponseSchema>;
