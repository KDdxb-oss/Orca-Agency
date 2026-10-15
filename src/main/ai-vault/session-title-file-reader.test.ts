import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const parseAgentSessionFileCached = vi.hoisted(() => vi.fn())

vi.mock('./session-scanner-parse-cache', () => ({ parseAgentSessionFileCached }))

const { readAiVaultSessionTitlesFromFiles } = await import('./session-title-file-reader')
const { parseAiVaultSessionTitlesResult } = await import('./session-title-result-validation')
const { resolveHostReadableAiVaultTitleRequests } = await import('./session-title-request-paths')

let temporaryRoots: string[] = []

beforeEach(() => {
  parseAgentSessionFileCached.mockReset()
})

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-title-'))
  temporaryRoots.push(root)
  const path = join(root, 'session.jsonl')
  await writeFile(path, '{}\n')
  return path
}

describe('readAiVaultSessionTitlesFromFiles', () => {
  it('returns exact Claude headless classification across the title result boundary', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'claude',
      sessionId: 'headless',
      title: 'One-shot audit',
      messageCount: 1,
      previewMessages: [],
      isHeadless: true
    })
    const result = await readAiVaultSessionTitlesFromFiles([
      { agent: 'claude', sessionId: 'headless', transcriptPath: path }
    ])
    expect(parseAiVaultSessionTitlesResult(result).titles).toEqual([
      { agent: 'claude', sessionId: 'headless', title: 'One-shot audit', isHeadless: true }
    ])
  })

  it('does not publish a placeholder title from an unprompted session', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'claude',
      sessionId: 'empty',
      title: 'New chat',
      messageCount: 0,
      previewMessages: []
    })
    await expect(
      readAiVaultSessionTitlesFromFiles([
        { agent: 'claude', sessionId: 'empty', transcriptPath: path }
      ])
    ).resolves.toEqual({ titles: [] })
  })
  it('probes exact transcript paths in the background-scanner layer', async () => {
    const path = await transcriptPath()

    await expect(
      resolveHostReadableAiVaultTitleRequests([
        { agent: 'codex', sessionId: 'present', transcriptPath: path },
        { agent: 'claude', sessionId: 'missing', transcriptPath: `${path}.missing` }
      ])
    ).resolves.toEqual([
      { agent: 'codex', sessionId: 'present', transcriptPath: path },
      { agent: 'claude', sessionId: 'missing' }
    ])
  })

  it('reads only the exact requested transcript and validates its identity', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'session-1',
      title: '  Exact title  ',
      messageCount: 2,
      previewMessages: []
    })

    await expect(
      readAiVaultSessionTitlesFromFiles([
        { agent: 'codex', sessionId: 'session-1', transcriptPath: path }
      ])
    ).resolves.toEqual({
      titles: [{ agent: 'codex', sessionId: 'session-1', title: 'Exact title' }]
    })
    expect(parseAgentSessionFileCached).toHaveBeenCalledTimes(1)
    expect(parseAgentSessionFileCached.mock.calls[0]?.[0]).toMatchObject({
      agent: 'codex',
      file: { path }
    })
  })

  it('rejects a transcript whose parsed identity does not match the request', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'different-session',
      title: 'Wrong title'
    })

    await expect(
      readAiVaultSessionTitlesFromFiles([
        { agent: 'codex', sessionId: 'session-1', transcriptPath: path }
      ])
    ).resolves.toEqual({ titles: [] })
  })

  it('uses the bounded worker index when no transcript path is available', async () => {
    const cached = {
      agent: 'claude' as const,
      sessionId: 'session-1',
      title: 'Cached title',
      isHeadless: true
    }
    const cache = { get: vi.fn(() => cached), set: vi.fn() }

    await expect(
      readAiVaultSessionTitlesFromFiles([{ agent: 'claude', sessionId: 'session-1' }], {
        cache
      })
    ).resolves.toEqual({
      titles: [{ agent: 'claude', sessionId: 'session-1', title: 'Cached title' }]
    })
    expect(parseAgentSessionFileCached).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('caps exact transcript reads at 64 identities', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'session-0',
      title: 'Title'
    })

    await readAiVaultSessionTitlesFromFiles(
      Array.from({ length: 65 }, (_, index) => ({
        agent: 'codex' as const,
        sessionId: `session-${index}`,
        transcriptPath: path
      }))
    )

    expect(parseAgentSessionFileCached).toHaveBeenCalledTimes(64)
  })
})
