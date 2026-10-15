import './mock-descendant-sweep'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonEndpointGeneration } from './daemon-endpoint-generation'
import { createLegacyDaemonAdapters, legacyDaemonEndpoints } from './daemon-legacy-adapters'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'
import { DaemonServer } from './daemon-server'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'

describe('Windows daemon endpoint generation', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('changes when the app version or CPU architecture changes', () => {
    const current = daemonEndpointGeneration('1.4.1031', 'arm64')
    expect(current).toMatch(/^[0-9a-f]{12}$/)
    expect(current).not.toBe(daemonEndpointGeneration('1.4.1030', 'arm64'))
    expect(current).not.toBe(daemonEndpointGeneration('1.4.1031', 'x64'))
  })

  it.runIf(process.platform === 'win32')('keeps old and new Windows paths distinct', () => {
    const directory = join(tmpdir(), 'orca-daemon-endpoint-paths')
    const oldGeneration = daemonEndpointGeneration('1.4.1030', 'x64')
    const newGeneration = daemonEndpointGeneration('1.4.1031', 'arm64')
    for (const getPath of [getDaemonSocketPath, getDaemonTokenPath, getDaemonPidPath]) {
      expect(getPath(directory, PROTOCOL_VERSION, newGeneration)).not.toBe(
        getPath(directory, PROTOCOL_VERSION, oldGeneration)
      )
    }
  })

  it.runIf(process.platform === 'win32')(
    'discovers prior generations without adopting the current host',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-daemon-generations-'))
      directories.push(directory)
      const oldGeneration = daemonEndpointGeneration('1.4.1030', 'x64')
      const tokenOnlyGeneration = daemonEndpointGeneration('1.4.1029', 'arm64')
      const currentGeneration = daemonEndpointGeneration('1.4.1031', 'arm64')
      for (const filename of [
        `daemon-v${PROTOCOL_VERSION}-g${oldGeneration}.pid`,
        `daemon-v${PROTOCOL_VERSION}-g${oldGeneration}.token`,
        `daemon-v${PROTOCOL_VERSION}-g${tokenOnlyGeneration}.token`,
        `daemon-v${PROTOCOL_VERSION}-g${currentGeneration}.pid`,
        `daemon-v${PROTOCOL_VERSION + 1}-g${oldGeneration}.pid`,
        'daemon-v39-ginvalid.pid'
      ]) {
        writeFileSync(join(directory, filename), '{}')
      }

      const endpoints = legacyDaemonEndpoints(directory, currentGeneration)
      expect(endpoints).toContainEqual({ protocolVersion: PROTOCOL_VERSION, generation: null })
      expect(endpoints).toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        generation: tokenOnlyGeneration
      })
      expect(endpoints.filter((endpoint) => endpoint.generation === oldGeneration)).toHaveLength(1)
      expect(endpoints).toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        generation: oldGeneration
      })
      expect(endpoints).not.toContainEqual({
        protocolVersion: PROTOCOL_VERSION,
        generation: currentGeneration
      })
      expect(endpoints).not.toContainEqual({
        protocolVersion: PROTOCOL_VERSION + 1,
        generation: oldGeneration
      })
    }
  )

  it.runIf(process.platform === 'win32')(
    'reattaches live sessions in plain and generated earlier hosts',
    async () => {
      const currentGeneration = daemonEndpointGeneration('1.4.1031', 'arm64')
      for (const oldGeneration of [null, daemonEndpointGeneration('1.4.1030', 'x64')]) {
        const directory = mkdtempSync(join(tmpdir(), 'orca-daemon-adopt-generation-'))
        directories.push(directory)
        const historyPath = join(directory, 'history')
        const socketPath = getDaemonSocketPath(directory, PROTOCOL_VERSION, oldGeneration)
        const tokenPath = getDaemonTokenPath(directory, PROTOCOL_VERSION, oldGeneration)
        const server = new DaemonServer({
          socketPath,
          tokenPath,
          protocolVersion: PROTOCOL_VERSION,
          spawnSubprocess: () => createMockSubprocess()
        })
        const originalAdapter = new DaemonPtyAdapter({
          socketPath,
          tokenPath,
          protocolVersion: PROTOCOL_VERSION
        })
        const discovered: DaemonPtyAdapter[] = []
        try {
          await server.start()
          writeFileSync(
            getDaemonPidPath(directory, PROTOCOL_VERSION, oldGeneration),
            JSON.stringify({ pid: process.pid, startedAtMs: Date.now() })
          )
          const session = await originalAdapter.spawn({
            sessionId: 'keep-this-session',
            cols: 80,
            rows: 24
          })
          originalAdapter.dispose()
          discovered.push(
            ...(await createLegacyDaemonAdapters(directory, historyPath, currentGeneration))
          )
          const legacy = discovered.find((adapter) => adapter.hasPty(session.id)) ?? discovered[0]
          expect(legacy).toBeDefined()
          const resumed = await legacy.spawn({
            sessionId: session.id,
            cols: 80,
            rows: 24,
            attachOnly: true
          })
          expect(resumed).toMatchObject({
            id: session.id,
            incarnationId: session.incarnationId,
            isReattach: true
          })
        } finally {
          originalAdapter.dispose()
          for (const adapter of discovered) {
            adapter.dispose()
          }
          await server.shutdown()
        }
      }
    }
  )
})
