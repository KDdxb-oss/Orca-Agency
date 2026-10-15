import { createHash } from 'node:crypto'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

export function daemonEndpointGeneration(appVersion: string, arch: string): string {
  return createHash('sha256').update(`${appVersion}:${arch}`).digest('hex').slice(0, 12)
}

export function currentDaemonEndpointGeneration(protocolVersion = PROTOCOL_VERSION): string | null {
  if (
    process.platform !== 'win32' ||
    protocolVersion !== PROTOCOL_VERSION ||
    !hasAppEnvironment() ||
    !getAppEnvironment().isPackaged()
  ) {
    return null
  }
  return daemonEndpointGeneration(getAppEnvironment().getVersion(), process.arch)
}
