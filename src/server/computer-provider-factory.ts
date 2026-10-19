import type { PlatformConfig } from './platform-config.js';
import type { ComputerProvider } from './computer-provider.js';
import { DockerSupervisorComputerProvider } from './docker-supervisor-provider.js';
import { CloudflareContainerComputerProvider } from './cloudflare-computer-provider.js';

/**
 * Resolve the selected provider in one place. Register future cloud/container/
 * micro-VM adapters here; ComputerService and the UI should remain provider-blind.
 */
export function createComputerProvider(
  config: PlatformConfig,
  transport: typeof fetch = fetch,
  deadlineMs = 70000,
): ComputerProvider {
  const selected =
    config.computerProvider?.trim().toLowerCase() || 'docker-supervisor';
  switch (selected) {
    case 'docker-supervisor':
      return new DockerSupervisorComputerProvider(
        config,
        transport,
        deadlineMs,
      );
    case 'cloudflare-containers':
      return new CloudflareContainerComputerProvider(config, transport, deadlineMs);
    default:
      throw new Error(
        `Unsupported COMPUTER_PROVIDER "${selected}". Add and register a ComputerProvider adapter before selecting it.`,
      );
  }
}
