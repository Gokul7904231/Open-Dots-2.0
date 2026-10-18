/**
 * Provider-neutral contract for one persistent computer per Dot.
 *
 * Providers own provisioning, lifecycle, endpoint discovery, and provider-specific
 * identity validation. ComputerService owns OpenDots permissions, per-Dot
 * credentials, browser actions, auditing, and the public API contract.
 *
 * An endpoint must be a validated origin (no path/query/fragment/userinfo),
 * reachable only through the provider's intended private or authenticated route.
 * Provider implementations must reject endpoints that are not bound to the
 * requested Dot; never trust a URL supplied by a Dot or an owner request.
 */
export type ComputerProviderStatus =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'failed';

export interface ComputerProviderState {
  dotId: string;
  status: ComputerProviderStatus;
  /** Normalized origin of this Dot's computer API; absent when not addressable. */
  endpoint?: string;
}

export interface ComputerProvider {
  /** Stable identifier used by deployment configuration and diagnostics. */
  readonly id: string;
  /** True only when this provider has the configuration it needs to provision. */
  readonly configured: boolean;
  /** Inspect a computer without creating or starting it. */
  get(dotId: string, signal?: AbortSignal): Promise<ComputerProviderState | undefined>;
  /** Ensure the Dot has a computer and return its validated provider state. */
  ensure(dotId: string, signal?: AbortSignal): Promise<ComputerProviderState>;
  /** Stop compute without deleting durable profile/workspace state. */
  stop(dotId: string, signal?: AbortSignal): Promise<void>;
}
