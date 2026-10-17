// Recorded provider sessions played back through the shipped structured-session host, its real
// Claude stream-json and Codex app-server connections included. Only the child process is fake:
// an in-memory one that answers what the connection writes with the recorded stdout frames
// (`structured-provider-replay-child-test-support.ts`; Codex: `structured-codex-replay-test-support.ts`).
// Transcript format and fixtures: see
// `__fixtures__/provider-replay/README.md`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { structuredAgentSessionAgentStatus } from '../../shared/structured-agent-session-agent-status'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'
import { replayUntil } from './structured-provider-replay-child-test-support'
import { createClaudeReplayCli } from './structured-claude-replay-cli-test-support'
import { AgentHookServer } from '../agent-hooks/server'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'

export type ReplayTranscriptEntry =
  | { type: 'transcript_start'; provider: string; protocol: string; version: string }
  | { type: 'expect_outbound'; label: string; frame: Record<string, unknown> }
  | { type: 'emit_inbound'; label: string; frame: Record<string, unknown> }
  | { type: 'runtime_exit' }

const FIXTURE_DIRECTORY = join(__dirname, '__fixtures__', 'provider-replay')
export const CALLER = { callerKey: 'provider-replay' }

/** The value as a plain record, or undefined: frames are untyped JSON. */
export function replayRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

export function replayString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseReplayEntry(line: string): ReplayTranscriptEntry {
  const raw = replayRecord(JSON.parse(line))
  const type = raw?.type
  const frame = replayRecord(raw?.frame)
  const label = replayString(raw?.label) ?? ''
  if ((type === 'expect_outbound' || type === 'emit_inbound') && frame) {
    return { type, label, frame }
  }
  if (type === 'transcript_start') {
    return {
      type,
      provider: replayString(raw?.provider) ?? '',
      protocol: replayString(raw?.protocol) ?? '',
      version: replayString(raw?.version) ?? ''
    }
  }
  if (type === 'runtime_exit') {
    return { type }
  }
  throw new Error(`unreadable transcript line: ${line.slice(0, 120)}`)
}

export function readReplayTranscript(name: string): ReplayTranscriptEntry[] {
  return readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseReplayEntry)
}

/** The row state the sidebar shows for one published summary, child work folded in. */
export function replayedAgentState(summary: AgentSessionStatusSummary): AgentStatusState | null {
  return summary.status === null
    ? null
    : structuredAgentSessionAgentStatus({
        status: summary.status,
        turnOutcome: summary.turnOutcome,
        stopping: summary.stopping,
        childWork: summary.children ?? summary.backgroundTasks
      }).state
}

/** Consecutive duplicates collapsed: what a person watching the row would have seen change. */
export function replayedStateSequence(
  statuses: readonly AgentSessionStatusSummary[]
): AgentStatusState[] {
  const sequence: AgentStatusState[] = []
  for (const summary of statuses) {
    const state = replayedAgentState(summary)
    if (state !== null && sequence.at(-1) !== state) {
      sequence.push(state)
    }
  }
  return sequence
}

export type ProviderReplay = {
  host: StructuredAgentSessionHost
  sessionId: string
  /** Every summary the host published for the session, in order. */
  statuses: AgentSessionStatusSummary[]
  /** The agent-status store the host writes its rows and child records into, as in production. */
  statusStore: AgentHookServer
  /** Sends the recorded prompt, then plays every recorded inbound frame. */
  play: (options?: ReplayPlayOptions) => Promise<void>
  /** Sends the played prompt again under the same operation id: whether the host replayed it. */
  resend: () => Promise<boolean>
  /** How many sends reached the provider. */
  dispatches: () => number
  dispose: () => Promise<void>
}

export type ReplayPlayOptions = {
  /** Runs once the frame at `index` (0-based, of `total` inbound frames) has been handed over. */
  afterFrame?: (index: number, total: number) => void | Promise<void>
}

export type ReplaySend = Parameters<StructuredAgentSessionHost['send']>[1]

let operations = 0
export const operationId = (): string =>
  `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

export async function sendPrompt(
  host: StructuredAgentSessionHost,
  sessionId: string,
  text: string
): Promise<ReplaySend> {
  const body = hostTestMessage(text)
  const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
  const params: ReplaySend = {
    envelope: {
      sessionId,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body }
      })
    },
    body
  }
  await resendPrompt(host, params)
  return params
}

/** Whether the host replayed the recorded outcome rather than taking the send as new. */
export async function resendPrompt(
  host: StructuredAgentSessionHost,
  params: ReplaySend
): Promise<boolean> {
  const sent = await host.send(CALLER, params)
  if (!sent.ok) {
    throw new Error(`replay send refused: ${JSON.stringify(sent.refusal)}`)
  }
  return sent.replayed
}

export function subscribeStatuses(
  host: StructuredAgentSessionHost,
  sessionId: string
): AgentSessionStatusSummary[] {
  const statuses: AgentSessionStatusSummary[] = []
  host.subscribeStatus({
    id: `provider-replay-${sessionId}`,
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === sessionId) {
        statuses.push(event.session)
      }
    }
  })
  return statuses
}

export function recordedPrompt(transcript: readonly ReplayTranscriptEntry[]): string {
  for (const entry of transcript) {
    if (entry.type !== 'expect_outbound') {
      continue
    }
    const claudeText = replayString(
      replayRecord(replayRecord(entry.frame.message)?.message)?.content
    )
    if (claudeText !== undefined) {
      return claudeText
    }
    const input = replayRecord(entry.frame.params)?.input
    for (const part of Array.isArray(input) ? input : []) {
      const codexText = replayString(replayRecord(part)?.text)
      if (codexText !== undefined) {
        return codexText
      }
    }
  }
  throw new Error('the transcript records no prompt')
}

export function resendPlayed(
  host: StructuredAgentSessionHost,
  played: ReplaySend | null
): Promise<boolean> {
  if (!played) {
    throw new Error('nothing has been played yet')
  }
  return resendPrompt(host, played)
}

/** The hook server's store wired as the host's status sink, the way the desktop wires it. */
export function replayStatusStore(): {
  store: AgentHookServer
  statusSink: StructuredAgentSessionStatusSink
} {
  const store = new AgentHookServer()
  return {
    store,
    statusSink: {
      publish: (summary, subject) => store.ingestStructuredStatus(summary, subject),
      forget: (subject) => store.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        store.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => store.getStructuredChildWorkViews(subject)
    }
  }
}

export const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function openClaudeReplay(fixture: string): Promise<ProviderReplay> {
  const transcript = readReplayTranscript(fixture)
  const sessionId = `replay-${fixture.replace(/\W+/g, '-')}`
  const prompt = recordedPrompt(transcript)
  let played: ReplaySend | null = null
  let playOptions: ReplayPlayOptions = {}
  const cli = createClaudeReplayCli({
    frames: transcript.flatMap((entry) => (entry.type === 'emit_inbound' ? [entry.frame] : [])),
    providerSessionId: claudeSessionIdForOrcaSession(sessionId),
    prompt,
    afterFrame: (index, total) => playOptions.afterFrame?.(index, total)
  })
  const claude = createScriptedClaudeRuntime([sessionId])
  const { store, statusSink } = replayStatusStore()
  const host = await claude.install({
    statusSink,
    openClaudeConnection: (launch, handlers = {}) =>
      openClaudeStreamJsonConnection(
        launch,
        {
          ...handlers,
          onMessage: (message) => {
            handlers.onMessage?.(message)
            cli.delivered()
          }
        },
        cli.spawnImpl
      )
  })
  const attached = await host.attach(CALLER, claude.attachParams(sessionId, null))
  if (!attached.ok) {
    throw new Error(`replay attach refused: ${JSON.stringify(attached.refusal)}`)
  }
  const statuses = subscribeStatuses(host, sessionId)
  return {
    host,
    sessionId,
    statuses,
    statusStore: store,
    play: async (options = {}) => {
      playOptions = options
      played = await sendPrompt(host, sessionId, prompt)
      await replayUntil(() => cli.dispatches() > 0)
      await cli.playing()
    },
    resend: () => resendPlayed(host, played),
    dispatches: cli.dispatches,
    dispose: () => claude.dispose()
  }
}
