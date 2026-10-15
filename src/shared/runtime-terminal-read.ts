export type RuntimeTerminalState = 'running' | 'exited' | 'unknown'

export type RuntimeTerminalRead = {
  handle: string
  status: RuntimeTerminalState
  tail: string[]
  truncated: boolean
  limited?: boolean
  oldestCursor?: string
  nextCursor: string | null
  latestCursor?: string
  returnedLineCount?: number
  source?: 'stream' | 'screen' | 'screen-unavailable'
  /** UI-only composer text, excluded from `tail`. */
  draft?: string
  composerState?: 'empty' | 'draft' | 'unknown'
}
