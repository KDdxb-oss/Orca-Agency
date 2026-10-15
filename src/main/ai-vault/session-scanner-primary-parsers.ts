import {
  remoteSessionContentLines,
  type RemoteSessionContent
} from './remote-session-content-lines'
import { openTranscriptReadStream } from '../native-chat/wsl-transcript-fs-access'
import { createInterface } from 'node:readline'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { isKnownHarnessInjectedUserTurnText } from '../../shared/harness-injected-user-turns'
import { normalizePromptField } from '../../shared/agent-status-field-normalization'
import type {
  FileWithMtime,
  ResumableSessionParseState,
  SessionAccumulator
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  accumulatorSessionIdentity,
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  timestampIso,
  updateLatestLocation,
  updateTimeline
} from './session-scanner-accumulator'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import {
  asRecord,
  claudeUsageTotal,
  extractMessageText,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'

type ParserSessionOptions = {
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}

const CLAUDE_BACKGROUND_RESUME_RESULT =
  /^<local-command-stdout>Opening [^\r\n]+, running in the background \(([0-9a-f]{8})\)<\/local-command-stdout>$/

function isClaudeHumanUserContent(content: unknown): boolean {
  const plain = extractString(content)
  if (plain) {
    return !isKnownHarnessInjectedUserTurnText(plain)
  }
  if (!Array.isArray(content)) {
    return false
  }
  let hasPrompt = false
  let firstText: string | null = null
  for (const item of content) {
    const block = asRecord(item)
    const text =
      typeof item === 'string'
        ? extractString(item)
        : block?.type === 'text'
          ? extractString(block.text)
          : null
    if (text) {
      firstText ??= text
      hasPrompt = true
    } else if (block?.type === 'image' || block?.type === 'document') {
      hasPrompt = true
    }
  }
  return hasPrompt && (!firstText || !isKnownHarnessInjectedUserTurnText(firstText))
}

// Parse state kept resumable so the scan cache can append newly written
// transcript lines without re-reading the whole (potentially huge) file.
export type ClaudeSessionParseState = {
  accumulator: SessionAccumulator
  metaTitle: string | null
  generatedTitle: string | null
  firstUserTitle: string | null
  resumedSessionIdPrefix: string | null
  lastHumanTurnAt: string | null
  sawSdkCli: boolean
  sawOtherEntrypoint: boolean
}

export function createClaudeSessionParseState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ClaudeSessionParseState {
  return {
    accumulator: createAccumulator({
      agent: 'claude',
      file,
      sessionId: sessionIdFromFileName(file.path),
      messages
    }),
    metaTitle: null,
    generatedTitle: null,
    firstUserTitle: null,
    resumedSessionIdPrefix: null,
    lastHumanTurnAt: null,
    sawSdkCli: false,
    sawOtherEntrypoint: false
  }
}

export function cloneClaudeSessionParseState(
  state: ClaudeSessionParseState
): ClaudeSessionParseState {
  return {
    accumulator: {
      ...state.accumulator,
      previewMessages: [...state.accumulator.previewMessages]
    },
    metaTitle: state.metaTitle,
    generatedTitle: state.generatedTitle,
    firstUserTitle: state.firstUserTitle,
    resumedSessionIdPrefix: state.resumedSessionIdPrefix,
    lastHumanTurnAt: state.lastHumanTurnAt,
    sawSdkCli: state.sawSdkCli,
    sawOtherEntrypoint: state.sawOtherEntrypoint
  }
}

export function consumeClaudeSessionLine(state: ClaudeSessionParseState, line: string): void {
  const { accumulator } = state
  const record = parseJsonObject(line)
  if (!record) {
    return
  }

  if (record.entrypoint === 'sdk-cli') {
    state.sawSdkCli = true
  } else if (typeof record.entrypoint === 'string' && record.entrypoint.trim()) {
    state.sawOtherEntrypoint = true
  }

  if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
    accumulator.sessionId = record.sessionId.trim()
  }
  updateTimeline(accumulator, extractString(record.timestamp))
  updateLatestLocation(accumulator, record)

  if (record.type === 'system' && record.subtype === 'local_command') {
    const command = asRecord(record.commandRun)
    const content = extractString(record.content)
    if (command?.command === 'resume') {
      const match = command.args === '' && content?.match(CLAUDE_BACKGROUND_RESUME_RESULT)
      state.resumedSessionIdPrefix = match && match[1] ? match[1] : null
    }
  }

  if (record.type === 'custom-title') {
    accumulator.title = normalizeTitleText(extractString(record.customTitle) ?? '')
    return
  }

  if (record.type === 'ai-title') {
    const title = normalizeTitleText(extractString(record.aiTitle) ?? '')
    if (title) {
      // Claude can revise generated names; AI Vault should mirror the current one.
      state.generatedTitle = title
    }
    return
  }

  if (record.type === 'agent-name' && !state.generatedTitle) {
    state.metaTitle ??= normalizeTitleText(extractString(record.agentName) ?? '')
    return
  }

  if (record.type === 'queue-operation') {
    // Enqueued prompts hold real content (e.g. queued subagent messages) that
    // survives even when the conversation was never persisted — recoverable
    // signal for an otherwise-empty session, but not a conversation turn.
    // Count net of remove/dequeue: consumed or user-removed prompts are written
    // as later queue-operation records and are no longer queued. Accepted gap:
    // a dequeue/remove of an uncounted empty-content enqueue can undercount,
    // which only hides the recoverable badge — it never fabricates one.
    if (record.operation === 'enqueue' && (extractString(record.content)?.trim().length ?? 0) > 0) {
      accumulator.queuedMessageCount++
    } else if (record.operation === 'remove' || record.operation === 'dequeue') {
      accumulator.queuedMessageCount = Math.max(0, accumulator.queuedMessageCount - 1)
    }
    return
  }

  if (record.type === 'last-prompt') {
    const prompt = normalizePromptField(record.lastPrompt)
    if (prompt) {
      accumulator.lastUserPrompt = prompt
    }
    return
  }

  if (record.type === 'user') {
    accumulator.messageCount++
    const content = asRecord(record.message)?.content
    const title = extractMessageText(record.message)
    // Meta prompts (injected context) only seed the last-resort title. Some
    // injected turns (task notifications) carry no isMeta, so also gate on
    // the known-tag classifier — a real prompt pasting a custom `<my-element>`
    // must seed the primary title, not be demoted as machinery.
    const isMetaUserTurn = record.isMeta === true || !isClaudeHumanUserContent(content)
    if (!isMetaUserTurn) {
      const at = timestampIso(record.timestamp)
      if (at && (!state.lastHumanTurnAt || at > state.lastHumanTurnAt)) {
        state.lastHumanTurnAt = at
      }
    }
    addPreviewContent(accumulator, 'user', content, record.timestamp, {
      seedFirstUserPrompt: !isMetaUserTurn
    })
    if (title) {
      if (isMetaUserTurn) {
        state.metaTitle ??= title
      } else {
        state.firstUserTitle ??= title
      }
    }
    return
  }

  if (record.type === 'assistant') {
    accumulator.messageCount++
    const message = asRecord(record.message)
    addPreviewContent(accumulator, 'assistant', message?.content, record.timestamp)
    const model = extractString(message?.model)
    if (model) {
      accumulator.model = model
    }
    accumulator.totalTokens += claudeUsageTotal(message?.usage)
  }
}

export async function finalizeClaudeSessionParseState(
  state: ClaudeSessionParseState,
  platform: NodeJS.Platform,
  options: ParserSessionOptions = {}
): Promise<AiVaultSession | null> {
  // Finalize a snapshot: the live state (and its preview array) may keep
  // accumulating appended lines after this session object is handed out.
  const snapshot = cloneClaudeSessionParseState(state)
  // Why: a user-set custom-title (accumulator.title) wins, but Claude's generated
  // session name (ai-title) should outrank the raw first prompt when present.
  snapshot.accumulator.fallbackTitle =
    snapshot.generatedTitle ?? snapshot.firstUserTitle ?? snapshot.metaTitle
  // Every session's sibling subagent transcripts are counted (one readdir):
  // the row UI shows the count without expanding details, and for zero-turn
  // transcripts it doubles as the recoverable-content signal. The sibling dir
  // lives on the host that owns the transcript, so content fetched from a
  // remote (SSH) host must not readdir this machine's disk. Runtime hosts scan
  // their own local disk (their host id is stamped after parse), so they are
  // already covered by the undefined-executionHostId branch.
  const ownsTranscriptDisk =
    !options.executionHostId || options.executionHostId === LOCAL_EXECUTION_HOST_ID
  if (ownsTranscriptDisk) {
    snapshot.accumulator.subagentTranscriptCount = await countSubagentTranscripts(
      snapshot.accumulator.filePath
    )
  }
  const session = finalizeSession(snapshot.accumulator, platform, options)
  return session
    ? {
        ...session,
        ...(snapshot.resumedSessionIdPrefix
          ? { resumedSessionIdPrefix: snapshot.resumedSessionIdPrefix }
          : {}),
        ...(snapshot.lastHumanTurnAt ? { lastHumanTurnAt: snapshot.lastHumanTurnAt } : {}),
        ...(snapshot.sawSdkCli && !snapshot.sawOtherEntrypoint ? { isHeadless: true as const } : {})
      }
    : null
}

export function createClaudeSessionResumeState(
  file: FileWithMtime,
  messages?: TranscriptMessageSink
): ResumableSessionParseState {
  return claudeResumeStateFromParseState(createClaudeSessionParseState(file, messages))
}

function claudeResumeStateFromParseState(
  state: ClaudeSessionParseState
): ResumableSessionParseState {
  return {
    consumeLine: (line) => consumeClaudeSessionLine(state, line),
    identity: () => accumulatorSessionIdentity(state.accumulator),
    clone: () => claudeResumeStateFromParseState(cloneClaudeSessionParseState(state)),
    touchFile: (file) => {
      state.accumulator.modifiedAt = file.modifiedAt
    },
    finalize: (platform, options) => finalizeClaudeSessionParseState(state, platform, options)
  }
}

export async function parseClaudeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const lines = createInterface({
    input: openTranscriptReadStream(file.path, { encoding: 'utf-8' }, 'scan'),
    crlfDelay: Infinity
  })
  return parseClaudeSessionLines({ file, lines, platform, messages })
}

export async function parseClaudeSessionContent(
  file: FileWithMtime,
  content: RemoteSessionContent,
  platform: NodeJS.Platform = process.platform,
  options: ParserSessionOptions = {},
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseClaudeSessionLines({
    file,
    lines: remoteSessionContentLines(content, signal),
    platform,
    options
  })
}

async function parseClaudeSessionLines(args: {
  file: FileWithMtime
  lines: AsyncIterable<string> | Iterable<string>
  platform: NodeJS.Platform
  options?: ParserSessionOptions
  messages?: TranscriptMessageSink
}): Promise<AiVaultSession | null> {
  const state = createClaudeSessionParseState(args.file, args.messages)
  for await (const line of args.lines) {
    consumeClaudeSessionLine(state, line)
  }
  return finalizeClaudeSessionParseState(state, args.platform, args.options)
}
