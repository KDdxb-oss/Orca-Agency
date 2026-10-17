// What a structured session's per-turn git checkpoint reads as on the wire (`agentSession.turnCheckpoint*`).
// Shared so the CLI and renderer read the shapes without the main-process git module.

export type AgentTurnCheckpointListing = { turnId: string; ref: string; commit: string }

export type AgentTurnCheckpointFile = {
  path: string
  /** Set when the turn renamed the file. */
  oldPath?: string
  /** Null for a binary file. */
  added: number | null
  removed: number | null
}

export type AgentTurnCheckpointDiff = {
  sessionId: string
  turnId: string
  ref: string
  /** The checkpoint commit; its first parent is the turn's start, so it opens as a commit diff. */
  commit: string
  /** The first 500 changed files. */
  files: AgentTurnCheckpointFile[]
  fileCount: number
  added: number
  removed: number
  /** More files than listed, or a patch larger than 1 MB. */
  truncated: boolean
}

export type AgentTurnCheckpointRollback =
  | { ok: true; restored: number }
  | { ok: false; reason: 'no-checkpoint' | 'changed-since-turn' | 'head-moved'; message: string }
