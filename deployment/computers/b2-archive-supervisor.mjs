import Docker from 'dockerode';
import {
  BOT_LABEL,
  DEFAULT_NAMESPACE,
  NAMESPACE,
  NAMESPACE_LABEL,
  OWNER_LABEL,
} from './names';
import { createBackupSupervisor } from './b2-archive-core.mjs';

const docker = new Docker(
  process.env.DOCKER_SOCKET
    ? { socketPath: process.env.DOCKER_SOCKET }
    : undefined,
);

const supervisor = createBackupSupervisor({
  docker,
  namespace: NAMESPACE,
  defaultNamespace: DEFAULT_NAMESPACE,
  labels: { owner: OWNER_LABEL, bot: BOT_LABEL, namespace: NAMESPACE_LABEL },
  image: () =>
    process.env.COMPUTER_IMAGE?.trim() || 'openbot-agent-computer:latest',
});

export const { attachBackupRoutes, lifecycleGuard, isBackupLocked } =
  supervisor;
