import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'
import { currentDaemonEndpointGeneration } from './daemon-endpoint-generation'

export type LegacyEndpoint = { protocolVersion: number; generation: string | null }

export function legacyDaemonEndpoints(
  runtimeDir: string,
  currentGeneration = currentDaemonEndpointGeneration()
): LegacyEndpoint[] {
  const endpoints: LegacyEndpoint[] = PREVIOUS_DAEMON_PROTOCOL_VERSIONS.map((protocolVersion) => ({
    protocolVersion,
    generation: null
  }))
  // A packaged Windows update gets a new endpoint for fresh PTYs. Keep prior
  // generations discoverable so live sessions stay attached to their original host.
  if (process.platform !== 'win32' || !currentGeneration) {
    return endpoints
  }
  // The first generation-scoped release must still find the earlier plain
  // endpoint with the same wire protocol and retain every session it owns.
  endpoints.push({ protocolVersion: PROTOCOL_VERSION, generation: null })
  const discovered = new Set<string>()
  try {
    for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
      const match =
        entry.isFile() && /^daemon-v(\d+)-g([0-9a-f]{12})\.(?:pid|token)$/.exec(entry.name)
      if (!match) {
        continue
      }
      const protocolVersion = Number(match[1])
      const generation = match[2]
      if (
        protocolVersion > PROTOCOL_VERSION ||
        (protocolVersion === PROTOCOL_VERSION && generation === currentGeneration)
      ) {
        continue
      }
      const key = `${protocolVersion}:${generation}`
      if (discovered.has(key)) {
        continue
      }
      discovered.add(key)
      endpoints.push({ protocolVersion, generation })
    }
  } catch {
    // A missing runtime directory has no prior generations to adopt.
  }
  return endpoints
}

function legacyDaemonProcessMayBeAlive(
  runtimeDir: string,
  protocolVersion: number,
  generation: string | null
): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion, generation), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch {
    return false
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir(),
  currentGeneration = currentDaemonEndpointGeneration()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const { protocolVersion, generation } of legacyDaemonEndpoints(
    runtimeDir,
    currentGeneration
  )) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion, generation)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion, generation)
    if (!(await probeSocket(socketPath))) {
      // Why: a recycled stale pid later turns an identity check into a PowerShell spawn, so delete leaked pid/token files — but only when the pid-process is provably gone (a live daemon can transiently fail the probe, and dropping its token makes its sessions permanently unadoptable).
      if (
        protocolVersion < PROTOCOL_VERSION &&
        generation === null &&
        !legacyDaemonProcessMayBeAlive(runtimeDir, protocolVersion, generation)
      ) {
        for (const stalePath of [
          getDaemonPidPath(runtimeDir, protocolVersion, generation),
          getDaemonTokenPath(runtimeDir, protocolVersion, generation)
        ]) {
          try {
            unlinkSync(stalePath)
          } catch {
            // Best-effort
          }
        }
      }
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion, generation),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
