// The Codex half of the provider replay: a fake app-server connection that answers each request
// with its recorded result and plays the notifications recorded after it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import {
  CALLER,
  nextTick,
  operationId,
  readReplayTranscript,
  recordedPrompt,
  resendPlayed,
  sendPrompt,
  subscribeStatuses,
  type ProviderReplay,
  type ReplayPlayOptions,
  type ReplaySend
} from './structured-provider-replay-test-support'

/** Codex echoes the `clientUserMessageId` a turn/start carried as its user item's `clientId`; a
 *  recorder that sent none left it null. */
function withSendEcho(params: unknown, clientId: unknown): unknown {
  const item = (params as { item?: Record<string, unknown> } | null)?.item
  return item?.type === 'userMessage' && item.clientId == null && typeof clientId === 'string'
    ? { ...(params as Record<string, unknown>), item: { ...item, clientId } }
    : params
}

export async function openCodexReplay(fixture: string): Promise<ProviderReplay> {
  const transcript = readReplayTranscript(fixture)
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-replay-'))
  // Each recorded request's result, keyed by method, and the notifications that followed it.
  const results = new Map<string, unknown[]>()
  const notificationsAfter = new Map<string, Record<string, unknown>[]>()
  const methodById = new Map<unknown, string>()
  let lastRequest = 'thread/start'
  for (const entry of transcript) {
    if (entry.type === 'expect_outbound' && typeof entry.frame.method === 'string') {
      methodById.set(entry.frame.id, entry.frame.method)
      // The fake replaces the handshake, so its notifications ride with the thread's start.
      if (entry.frame.method !== 'initialize' && entry.frame.method !== 'initialized') {
        lastRequest = entry.frame.method
      }
    } else if (entry.type === 'emit_inbound' && 'result' in entry.frame) {
      const method = methodById.get(entry.frame.id)
      if (method) {
        results.set(method, [...(results.get(method) ?? []), entry.frame.result])
      }
    } else if (entry.type === 'emit_inbound' && typeof entry.frame.method === 'string') {
      notificationsAfter.set(lastRequest, [
        ...(notificationsAfter.get(lastRequest) ?? []),
        entry.frame
      ])
    }
  }
  let handlers: CodexAppServerConnectionHandlers = {}
  let clientUserMessageId: unknown = null
  const emitted = new Set<string>()
  let playing: Promise<void> = Promise.resolve()
  let playOptions: ReplayPlayOptions = {}
  let turnStarts = 0
  const total = [...notificationsAfter.values()].reduce((sum, list) => sum + list.length, 0)
  let delivered = 0
  const emitAfter = (method: string): void => {
    if (emitted.has(method)) {
      return
    }
    emitted.add(method)
    const notifications = notificationsAfter.get(method) ?? []
    playing = playing.then(async () => {
      for (const notification of notifications) {
        await nextTick()
        handlers.onNotification?.(
          String(notification.method),
          withSendEcho(notification.params, clientUserMessageId)
        )
        playOptions.afterFrame?.(delivered++, total)
      }
    })
  }
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        if (method === 'turn/start') {
          turnStarts += 1
          clientUserMessageId = (params as { clientUserMessageId?: unknown }).clientUserMessageId
        }
        const recorded = results.get(method)?.shift()
        if (method !== 'turn/start' && method !== 'thread/start') {
          return recorded ?? (method === 'model/list' ? { data: [], nextCursor: null } : {})
        }
        // After the answer is read, as the real channel orders them.
        setImmediate(() => emitAfter(method))
        return recorded ?? {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    }
    return connection
  }
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    openCodexConnection: openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(`replay attach refused: ${JSON.stringify(attached.refusal)}`)
  }
  const sessionId = attachParams.envelope.sessionId
  const statuses = subscribeStatuses(host, sessionId)
  let played: ReplaySend | null = null
  return {
    host,
    sessionId,
    statuses,
    play: async (options = {}) => {
      playOptions = options
      played = await sendPrompt(host, sessionId, recordedPrompt(transcript))
      while (!emitted.has('turn/start')) {
        await nextTick()
      }
      await playing
    },
    resend: () => resendPlayed(host, played),
    dispatches: () => turnStarts,
    dispose: async () => {
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  }
}
