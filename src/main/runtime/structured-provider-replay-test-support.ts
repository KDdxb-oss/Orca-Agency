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
  /** Sends the recorded prompt, then plays every recorded inbound frame. */
  play: () => Promise<void>
  dispose: () => Promise<void>
}

let operations = 0
export const operationId = (): string =>
  `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

export async function sendPrompt(
  host: StructuredAgentSessionHost,
  sessionId: string,
  text: string
): Promise<void> {
  const body = hostTestMessage(text)
  const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
  const sent = await host.send(CALLER, {
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
  })
  if (!sent.ok) {
    throw new Error(`replay send refused: ${JSON.stringify(sent.refusal)}`)
  }
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
  const host = await claude.install()
  const attached = await host.attach(CALLER, claude.attachParams(sessionId, null))
  if (!attached.ok) {
    throw new Error(`replay attach refused: ${JSON.stringify(attached.refusal)}`)
  }
  const statuses = subscribeStatuses(host, sessionId)
  const frames = transcript.flatMap((entry) => (entry.type === 'emit_inbound' ? [entry.frame] : []))
  const recordedSessionId = frames.find((frame) => typeof frame.session_id === 'string')
    ?.session_id as string | undefined
  return {
    host,
    sessionId,
    statuses,
    play: async () => {
      const child = claude.child(sessionId)
      const sent = Promise.withResolvers<Record<string, unknown>>()
      child.connection.send = async (message, beforeDispatch) => {
        await beforeDispatch?.()
        sent.resolve(message)
      }
      const prompt = recordedPrompt(transcript)
      await sendPrompt(host, sessionId, prompt)
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
      for (const frame of [echo, ...frames]) {
        let replayed = recordedSessionId
          ? withSessionId(frame, recordedSessionId, providerSessionId)
          : frame
        if (recordedCommand) {
          replayed = withSessionId(replayed, recordedCommand, sentUuid)
        }
        child.handlers.onMessage?.(replayed as Record<string, unknown>)
        await nextTick()
      }
    },
    dispose: () => claude.dispose()
  }
}
