import type { IBufferLine } from '@xterm/xterm'
import {
  extractTerminalFileLinks,
  resolveTerminalFileLink,
  type ParsedTerminalFileLink
} from '@/lib/terminal-links'
import { joinAbsolutePath, normalizeAbsolutePath } from '@/lib/terminal-path-normalization'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { mapTerminalFilePath, terminalLinkWslDistro } from './terminal-file-open-routing'
import { mayCheckFileLinkTargetUnprompted } from './terminal-file-link-target'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  wasTerminalPathExistsCacheRecentlyProbed,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine
} from './wrapped-terminal-link-ranges'

export type ContextualFileLinkTarget = { anchorPath: string; absolutePath: string }

const MAX_PRIOR_LINES = 80
const MAX_PRIOR_ANCHORS = 24
const MAX_DISTINCT_TARGETS = 8
const MAX_ANCHOR_CHARS = 2048

/** Collects bounded explicit paths once for all candidates in a hover turn. */
export function collectPriorTerminalFileLinkAnchors(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number,
  cwd: string,
  homePath?: string | null
): string[] {
  const anchors = new Map<string, string>()
  const seenLines = new Set<string>()
  const firstLine = Math.max(0, bufferLineNumber - 1 - MAX_PRIOR_LINES)
  const priorBuffer = {
    getLine: (index: number) =>
      index >= firstLine && index < bufferLineNumber - 1 ? buffer.getLine(index) : undefined
  }
  for (let index = bufferLineNumber - 2; index >= firstLine; index -= 1) {
    const line = priorBuffer.getLine(index)
    if (!line) {
      continue
    }
    if (line.isWrapped && priorBuffer.getLine(index - 1)) {
      continue
    }
    const hardWrapped = buildHardWrappedPathLogicalLineCandidates(priorBuffer, index + 1, 3).filter(
      (logical) => logical.rows.length > 1 && !/\.[\p{L}\p{N}_-]+$/u.test(logical.rows[0].text)
    )
    const logicalLines = [buildWrappedLogicalLine(priorBuffer, index + 1), ...hardWrapped]
    const lineTexts = [
      line.translateToString(true),
      ...logicalLines
        .filter((logical) => logical && logical.rows.at(-1)!.y < bufferLineNumber - 1)
        .map((logical) => logical!.text)
    ]
    for (const text of lineTexts) {
      if (!text || text.length > MAX_ANCHOR_CHARS || seenLines.has(text)) {
        continue
      }
      seenLines.add(text)
      for (const link of extractTerminalFileLinks(text)) {
        if (!/^(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(link.pathText)) {
          continue
        }
        const anchorPath = resolveTerminalFileLink(link, cwd, homePath)?.absolutePath
        const anchor = anchorPath && normalizeAbsolutePath(anchorPath)
        if (!anchor || /[\\/]$/.test(link.pathText)) {
          continue
        }
        anchors.set(anchor.comparisonKey, anchor.normalized)
        if (anchors.size >= MAX_PRIOR_ANCHORS) {
          return [...anchors.values()]
        }
      }
    }
  }
  return [...anchors.values()]
}

/** Finds file targets evidenced by explicit paths earlier in this pane's output. */
export function contextualFileLinkTargets(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number,
  relativePath: string,
  cwd: string,
  homePath?: string | null,
  priorAnchors?: readonly string[]
): ContextualFileLinkTarget[] {
  const relativeSegments = relativePath.split(/[\\/]+/)
  if (
    !/^[\p{L}\p{N}._-]+[\\/]/u.test(relativePath) ||
    relativeSegments.includes('..') ||
    relativeSegments[0] === '.'
  ) {
    return []
  }
  const targets = new Map<string, ContextualFileLinkTarget>()
  const distinctTargets = new Set<string>()
  const anchors =
    priorAnchors ?? collectPriorTerminalFileLinkAnchors(buffer, bufferLineNumber, cwd, homePath)
  for (const anchorPath of anchors.slice(0, MAX_PRIOR_ANCHORS)) {
    const anchor = normalizeAbsolutePath(anchorPath)
    if (!anchor) {
      continue
    }
    const anchorSegments = anchor.normalized.split('/')
    const same = (left: string, right: string): boolean =>
      anchor.rootKind === 'posix' ? left === right : left.toLowerCase() === right.toLowerCase()
    const absolutePaths: string[] = []
    if (
      anchorSegments.length >= relativeSegments.length &&
      relativeSegments.every((segment, offset) =>
        same(segment, anchorSegments[anchorSegments.length - relativeSegments.length + offset])
      )
    ) {
      absolutePaths.push(anchor.normalized)
    } else if (relativeSegments.length >= 3) {
      const directories = relativeSegments.slice(0, -1)
      for (let start = 0; start <= anchorSegments.length - 1 - directories.length; start += 1) {
        if (
          !directories.every((segment, offset) => same(segment, anchorSegments[start + offset]))
        ) {
          continue
        }
        const base = anchorSegments.slice(0, start).join('/') || '/'
        const path = joinAbsolutePath(base, relativePath)
        if (path) {
          absolutePaths.push(path)
        }
      }
    }
    for (const absolutePath of absolutePaths) {
      const targetKey = normalizeAbsolutePath(absolutePath)?.comparisonKey
      if (!targetKey) {
        continue
      }
      const key = `${anchor.comparisonKey}\0${targetKey}`
      if (!targets.has(key)) {
        targets.set(key, { anchorPath: anchor.normalized, absolutePath })
        distinctTargets.add(targetKey)
        if (distinctTargets.size > MAX_DISTINCT_TARGETS) {
          return []
        }
      }
    }
  }
  return [...targets.values()]
}

export async function resolveExistingTerminalFileLinkPath(args: {
  parsed: ParsedTerminalFileLink
  buffer: { getLine(y: number): IBufferLine | undefined }
  bufferLineNumber: number
  cwd: string
  homePath?: string | null
  worktreePath: string
  wslDistro?: string | null
  runtimeEnvironmentId: string | null
  fileContext: RuntimeFileOperationArgs
  pathExistsCache: Map<string, boolean>
  pathExists: (context: RuntimeFileOperationArgs, path: string, remote: boolean) => Promise<boolean>
  getPriorAnchors?: () => readonly string[]
}): Promise<string | null> {
  const resolved = resolveTerminalFileLink(args.parsed, args.cwd, args.homePath)
  if (!resolved) {
    return null
  }
  const mapPath = (path: string): string =>
    mapTerminalFilePath(
      path,
      args.worktreePath,
      terminalLinkWslDistro(args.wslDistro, args.runtimeEnvironmentId)
    )
  const cacheKey = (path: string): string => {
    const remote = isRemoteRuntimeFileOperation(args.fileContext, path)
    return getTerminalPathExistsCacheKey({
      absolutePath: path,
      connectionId: args.fileContext.connectionId,
      isRemoteRuntimePath: remote,
      runtimeEnvironmentId: args.runtimeEnvironmentId
    })
  }
  const exists = async (path: string, refresh = false, proof = false): Promise<boolean> => {
    const key = cacheKey(path)
    const cached =
      refresh || (proof && !wasTerminalPathExistsCacheRecentlyProbed(args.pathExistsCache, key))
        ? undefined
        : readTerminalPathExistsCache(args.pathExistsCache, key)
    if (cached !== undefined) {
      return cached
    }
    const remote = isRemoteRuntimeFileOperation(args.fileContext, path)
    const value = await args.pathExists(args.fileContext, path, remote)
    writeTerminalPathExistsCache(args.pathExistsCache, key, value)
    return value
  }
  const mappedPath = mapPath(resolved.absolutePath)
  const isAllowed = (path: string): boolean =>
    mayCheckFileLinkTargetUnprompted(
      {
        absolutePath: path,
        isKnownWorktreeRoot: Boolean(
          resolveKnownWorktreeRootPathLink(path, undefined, args.fileContext)
        ),
        isRemoteRuntimePath: isRemoteRuntimeFileOperation(args.fileContext, path)
      },
      {
        worktreePath: args.worktreePath,
        wslDistro: args.wslDistro,
        runtimeEnvironmentId: args.runtimeEnvironmentId
      }
    )
  if (resolveKnownWorktreeRootPathLink(mappedPath, undefined, args.fileContext)) {
    return mappedPath
  }
  if (!isAllowed(mappedPath)) {
    return null
  }
  if (/[\\/]$/.test(args.parsed.pathText)) {
    return null
  }
  const mappedKey = cacheKey(mappedPath)
  const staleMiss =
    args.pathExistsCache.get(mappedKey) === false &&
    !wasTerminalPathExistsCacheRecentlyProbed(args.pathExistsCache, mappedKey)
  if (await exists(mappedPath, staleMiss)) {
    return mappedPath
  }

  const candidates = contextualFileLinkTargets(
    args.buffer,
    args.bufferLineNumber,
    args.parsed.pathText,
    args.cwd,
    args.homePath,
    args.getPriorAnchors?.()
  )
  const verified = await Promise.all(
    candidates.map(async ({ anchorPath, absolutePath }) => {
      const anchor = mapPath(anchorPath)
      const target = mapPath(absolutePath)
      if (!isAllowed(anchor) || !isAllowed(target)) {
        return null
      }
      return (await exists(anchor, false, true)) && (await exists(target, false, true))
        ? target
        : null
    })
  )
  const unique = new Map<string, string>()
  for (const path of verified) {
    if (path) {
      const normalized = normalizeAbsolutePath(path)
      if (normalized) {
        unique.set(normalized.comparisonKey, path)
      }
    }
  }
  return unique.size === 1 ? [...unique.values()][0] : null
}
