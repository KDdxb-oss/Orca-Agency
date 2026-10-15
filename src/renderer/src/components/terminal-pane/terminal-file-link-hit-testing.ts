import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import {
  mapTerminalFilePath,
  openDetectedFilePath,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import { resolveFileLinkTarget, type FileLinkTarget } from './terminal-file-link-target'
import {
  collectPriorTerminalFileLinkAnchors,
  contextualFileLinkTargets
} from './terminal-relative-file-link-context'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  wasTerminalPathExistsCacheRecentlyProbed
} from './terminal-path-exists-cache'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-client'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

type FileLinkHitTestDeps = {
  startupCwd: string
  terminalHomePath?: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  pathExistsCache?: Map<string, boolean>
  openWithSystemDefault?: boolean
}

export function openFilePathLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: FileLinkHitTestDeps
): boolean {
  const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, position.y)
  if (logicalLines.length === 0) {
    return false
  }

  for (const logicalLine of logicalLines) {
    const matches: {
      absolutePath: string
      line: number | null
      column: number | null
      pathText: string
      cachedExists: boolean | undefined
      isKnownWorktreeRoot: boolean
      fileContext: FileLinkTarget['fileContext']
    }[] = []
    for (const parsed of extractTerminalFileLinkCandidates(logicalLine.text)) {
      const target = resolveFileLinkTarget(parsed, {
        cwd: deps.startupCwd,
        homePath: deps.terminalHomePath,
        worktreeId: deps.worktreeId,
        worktreePath: deps.worktreePath,
        runtimeEnvironmentId: deps.runtimeEnvironmentId,
        wslDistro: deps.wslDistro
      })
      if (!target) {
        continue
      }
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      matches.push({
        absolutePath: target.absolutePath,
        line: target.line,
        column: target.column,
        pathText: parsed.pathText,
        cachedExists: deps.pathExistsCache?.get(target.cacheKey),
        isKnownWorktreeRoot: target.isKnownWorktreeRoot,
        fileContext: target.fileContext
      })
    }

    const cachedMatch = matches
      .filter((match) => match.cachedExists)
      .sort((a, b) => b.pathText.length - a.pathText.length)[0]
    const knownWorktreeRootMatch = matches
      .filter((match) => match.isKnownWorktreeRoot)
      .sort((a, b) => b.pathText.length - a.pathText.length)[0]
    // Why: an earlier absolute path can prove this relative text names a different folder.
    const hasContext =
      collectPriorTerminalFileLinkAnchors(
        buffer,
        position.y,
        deps.startupCwd,
        deps.terminalHomePath
      ).length > 0
    const contextualMatches =
      hasContext && deps.pathExistsCache
        ? matches.flatMap((candidate) => {
            if (!/^[\p{L}\p{N}._-]+[\\/]/u.test(candidate.pathText)) {
              return []
            }
            const targets = contextualFileLinkTargets(
              buffer,
              position.y,
              candidate.pathText,
              deps.startupCwd,
              deps.terminalHomePath
            )
            const cacheValue = (path: string): boolean | undefined => {
              const mapped = mapTerminalFilePath(
                path,
                deps.worktreePath,
                terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
              )
              const cacheKey = getTerminalPathExistsCacheKey({
                absolutePath: mapped,
                connectionId: candidate.fileContext.connectionId,
                isRemoteRuntimePath: isRemoteRuntimeFileOperation(candidate.fileContext, mapped),
                runtimeEnvironmentId: deps.runtimeEnvironmentId
              })
              return wasTerminalPathExistsCacheRecentlyProbed(deps.pathExistsCache!, cacheKey)
                ? readTerminalPathExistsCache(deps.pathExistsCache!, cacheKey)
                : undefined
            }
            const unresolved = targets.some(
              ({ anchorPath, absolutePath }) =>
                cacheValue(anchorPath) === undefined || cacheValue(absolutePath) === undefined
            )
            if (unresolved) {
              return []
            }
            const verified = targets.filter(
              ({ anchorPath, absolutePath }) =>
                cacheValue(anchorPath) === true && cacheValue(absolutePath) === true
            )
            const paths = new Set(verified.map(({ absolutePath }) => absolutePath))
            if (paths.size !== 1) {
              return []
            }
            const absolutePath = mapTerminalFilePath(
              verified[0].absolutePath,
              deps.worktreePath,
              terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
            )
            return [{ ...candidate, absolutePath }]
          })
        : []
    const uncachedMatch = hasContext
      ? matches.find(
          (candidate) =>
            candidate.cachedExists !== false && !/^[\p{L}\p{N}._-]+[\\/]/u.test(candidate.pathText)
        )
      : matches.find((candidate) => candidate.cachedExists !== false)
    const match =
      cachedMatch ??
      knownWorktreeRootMatch ??
      (contextualMatches.length === 1 ? contextualMatches[0] : undefined) ??
      uncachedMatch
    if (match) {
      openDetectedFilePath(match.absolutePath, match.line, match.column, {
        ...deps,
        openWithSystemDefault: deps.openWithSystemDefault === true
      })
      return true
    }
  }

  return false
}

export function buildCandidateLogicalLinesForBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const hardWrappedCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber)
  const softWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  const candidates = softWrappedLogicalLine
    ? [...hardWrappedCandidates, softWrappedLogicalLine]
    : hardWrappedCandidates
  return dedupeLogicalLines(candidates)
}

export function dedupeLogicalLines(logicalLines: WrappedLogicalLine[]): WrappedLogicalLine[] {
  const seen = new Set<string>()
  return logicalLines.filter((logicalLine) => {
    if (seen.has(logicalLine.fingerprint)) {
      return false
    }
    seen.add(logicalLine.fingerprint)
    return true
  })
}

function rangeContainsBufferPosition(
  range: IBufferRange,
  position: { x: number; y: number },
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
