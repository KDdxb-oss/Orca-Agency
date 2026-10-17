// Recorded provider sessions played back through the shipped structured-session host. Only the
// transport is fake: a Claude transcript's inbound frames reach the adapter exactly as the Agent
// SDK yields them, and a Codex transcript's JSON-RPC results and notifications reach it exactly as
// the app-server connection hands them over (Codex: `structured-codex-replay-test-support.ts`).
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
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'
import { AgentHookServer } from '../agent-hooks/server'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'

export type ReplayTranscriptEntry =
  | { type: 'transcript_start'; provider: string; protocol: string; version: string }
  | { type: 'expect_outbound'; label: string; frame: Record<string, unknown> }
  | { type: 'emit_inbound'; label: string; frame: Record<string, unknown> }
  | { type: 'runtime_exit' }

const FIXTURE_DIRECTORY = join(__dirname, '__fixtures__', 'provider-replay')
export const CALLER = { callerKey: 'provider-replay' }

export function readReplayTranscript(name: string): ReplayTranscriptEntry[] {
  return readFileSync(join(FIXTURE_DIRECTORY, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReplayTranscriptEntry)
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
    const message = (entry.frame.message as { message?: { content?: unknown } } | undefined)
      ?.message
    if (typeof message?.content === 'string') {
      return message.content
    }
    const input = (entry.frame.params as { input?: { text?: unknown }[] } | undefined)?.input
    const text = input?.find((part) => typeof part.text === 'string')?.text
    if (typeof text === 'string') {
      return text
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

/** Rewrites the recorded provider session id to the one this run launched, so the adapter's
 *  ownership check reads the frames as its own. */
function withSessionId(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => withSessionId(entry, from, to))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withSessionId(entry, from, to)])
    )
  }
  return value === from ? to : value
}

export async function openClaudeReplay(fixture: string): Promise<ProviderReplay> {
  const transcript = readReplayTranscript(fixture)
  const sessionId = `replay-${fixture.replace(/\W+/g, '-')}`
  const providerSessionId = claudeSessionIdForOrcaSession(sessionId)
  const claude = createScriptedClaudeRuntime([sessionId])
  const { store, statusSink } = replayStatusStore()
  const host = await claude.install({ statusSink })
  const attached = await host.attach(CALLER, claude.attachParams(sessionId, null))
  if (!attached.ok) {
    throw new Error(`replay attach refused: ${JSON.stringify(attached.refusal)}`)
  }
  const statuses = subscribeStatuses(host, sessionId)
  const frames = transcript.flatMap((entry) => (entry.type === 'emit_inbound' ? [entry.frame] : []))
  const recordedSessionId = frames.find((frame) => typeof frame.session_id === 'string')
    ?.session_id as string | undefined
  let played: ReplaySend | null = null
  let dispatches = 0
  return {
    host,
    sessionId,
    statuses,
    statusStore: store,
    play: async (options = {}) => {
      const child = claude.child(sessionId)
      const sent = Promise.withResolvers<Record<string, unknown>>()
      child.connection.send = async (message, beforeDispatch) => {
        await beforeDispatch?.()
        dispatches += 1
        sent.resolve(message)
      }
      const prompt = recordedPrompt(transcript)
      played = await sendPrompt(host, sessionId, prompt)
      const sentUuid = String((await sent.promise).uuid)
      // The CLI replays Orca's own send back (--replay-user-messages); a recorder that sent
      // without it left no echo, and its command uuid was its own.
      const recordedCommand = frames.find((frame) => typeof frame.command_uuid === 'string')
        ?.command_uuid as string | undefined
      const echo = {
        type: 'user',
        parent_tool_use_id: null,
        session_id: providerSessionId,
        uuid: sentUuid,
        message: { role: 'user', content: [{ type: 'text', text: prompt }] }
      }
      for (const [index, frame] of [echo, ...frames].entries()) {
        let replayed = recordedSessionId
          ? withSessionId(frame, recordedSessionId, providerSessionId)
          : frame
        if (recordedCommand) {
          replayed = withSessionId(replayed, recordedCommand, sentUuid)
        }
        child.handlers.onMessage?.(replayed as Record<string, unknown>)
        await nextTick()
        await options.afterFrame?.(index, frames.length + 1)
      }
    },
    resend: () => resendPlayed(host, played),
    dispatches: () => dispatches,
    dispose: () => claude.dispose()
  }
}
