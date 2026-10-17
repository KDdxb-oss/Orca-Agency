// The Codex half of the provider replay: the real app-server connection, over an in-memory child
// that answers each request with its recorded result and the notifications recorded after it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { installStructuredAgentTurnCheckpoints } from './structured-agent-session-turn-checkpoints'
import {
  CALLER,
  operationId,
  readReplayTranscript,
  recordedPrompt,
  replayRecord,
  replayStatusStore,
  replayString,
  resendPlayed,
  sendPrompt,
  subscribeStatuses,
  type ProviderReplay,
  type ReplayPlayOptions,
  type ReplaySend
} from './structured-provider-replay-test-support'
import { replayChildSpawn, replayUntil } from './structured-provider-replay-child-test-support'

/** Codex echoes the `clientUserMessageId` a turn/start carried as its user item's `clientId`; a
 *  recorder that sent none left it null. */
function withSendEcho(params: unknown, clientId: unknown): unknown {
  const record = replayRecord(params)
  const item = replayRecord(record?.item)
  return item?.type === 'userMessage' && item.clientId == null && typeof clientId === 'string'
    ? { ...record, item: { ...item, clientId } }
    : params
}

export type CodexReplayOptions = {
  /** The folder the session's agent works in; the replay's own scratch folder by default. */
  workspace?: string
  turnCheckpoints?: true
}

export async function openCodexReplay(
  fixture: string,
  options: CodexReplayOptions = {}
): Promise<ProviderReplay> {
  const transcript = readReplayTranscript(fixture)
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-replay-'))
  // The inbound frames recorded after each request, until the next one, queued by method.
  const answers = new Map<string, Record<string, unknown>[][]>()
  let answering: Record<string, unknown>[] | null = null
  for (const entry of transcript) {
    if (entry.type === 'expect_outbound' && typeof entry.frame.method === 'string') {
      if (entry.frame.id !== undefined) {
        answering = []
        answers.set(entry.frame.method, [...(answers.get(entry.frame.method) ?? []), answering])
      }
    } else if (entry.type === 'emit_inbound') {
      answering?.push(entry.frame)
    }
  }
  const total = transcript.filter(
    (entry) => entry.type === 'emit_inbound' && typeof entry.frame.method === 'string'
  ).length
  let clientUserMessageId: unknown = null
  let playing: Promise<void> = Promise.resolve()
  let playOptions: ReplayPlayOptions = {}
  let turnStarts = 0
  let written = 0
  let notified = 0
  const spawnImpl = replayChildSpawn((frame, write) => {
    const method = replayString(frame.method)
    // Orca's notifications and its answers to server requests need no reply.
    if (method === undefined || frame.id === undefined) {
      return
    }
    if (method === 'turn/start') {
      turnStarts += 1
      clientUserMessageId = replayRecord(frame.params)?.clientUserMessageId
    }
    const recorded = answers.get(method)?.shift() ?? [
      { id: frame.id, result: method === 'model/list' ? { data: [], nextCursor: null } : {} }
    ]
    playing = playing.then(async () => {
      for (const inbound of recorded) {
        if (typeof inbound.method !== 'string') {
          // The recorded answer, under the id this run's request actually carried.
          write({ ...inbound, id: frame.id })
          continue
        }
        const index = written++
        write({ ...inbound, params: withSendEcho(inbound.params, clientUserMessageId) })
        await replayUntil(() => notified > index)
        await playOptions.afterFrame?.(index, total)
      }
    })
  })
  const openConnection: typeof openCodexAppServerConnection = (launch, handlers = {}) =>
    openCodexAppServerConnection(
      launch,
      {
        ...handlers,
        onNotification: (method, params) => {
          handlers.onNotification?.(method, params)
          notified += 1
        }
      },
      spawnImpl
    )
  const { store, statusSink } = replayStatusStore()
  const host = await ensureStructuredAgentSessionHost({
    statusSink,
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => options.workspace ?? root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    openCodexConnection: openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
  if (options.turnCheckpoints) {
    installStructuredAgentTurnCheckpoints(host, createStructuredAgentSessionLogger())
  }
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
    statusStore: store,
    play: async (options = {}) => {
      playOptions = options
      played = await sendPrompt(host, sessionId, recordedPrompt(transcript))
      await replayUntil(() => turnStarts > 0)
      // Each answer can queue more; done once the queue stops growing.
      for (let tail = playing; ; tail = playing) {
        await tail
        if (tail === playing) {
          break
        }
      }
    },
    resend: () => resendPlayed(host, played),
    dispatches: () => turnStarts,
    dispose: async () => {
      await stopStructuredAgentSessionRuntime()
      await rm(root, { recursive: true, force: true })
    }
  }
}
