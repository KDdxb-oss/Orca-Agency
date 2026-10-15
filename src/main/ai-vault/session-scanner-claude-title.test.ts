import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions Claude title selection', () => {
  it('marks sdk-cli transcripts as headless while keeping them in session history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-headless-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')
    await writeJsonlFile(join(projectDir, 'headless.jsonl'), [
      {
        type: 'user',
        sessionId: 'headless',
        entrypoint: 'sdk-cli',
        timestamp: '2026-10-01T08:00:00.000Z',
        message: { role: 'user', content: 'One-shot audit' }
      }
    ])
    await writeJsonlFile(join(projectDir, 'interactive.jsonl'), [
      {
        type: 'user',
        sessionId: 'interactive',
        entrypoint: 'cli',
        timestamp: '2026-10-01T08:00:00.000Z',
        message: { role: 'user', content: 'Interactive work' }
      }
    ])
    await writeJsonlFile(join(projectDir, 'resumed-interactively.jsonl'), [
      {
        type: 'user',
        sessionId: 'resumed-interactively',
        entrypoint: 'sdk-cli',
        message: { role: 'user', content: 'One-shot start' }
      },
      {
        type: 'user',
        sessionId: 'resumed-interactively',
        entrypoint: 'cli',
        message: { role: 'user', content: 'Continue in a terminal' }
      }
    ])
    await writeJsonlFile(join(projectDir, 'used-headlessly.jsonl'), [
      {
        type: 'user',
        sessionId: 'used-headlessly',
        entrypoint: 'cli',
        message: { role: 'user', content: 'Terminal start' }
      },
      {
        type: 'user',
        sessionId: 'used-headlessly',
        entrypoint: 'sdk-cli',
        message: { role: 'user', content: 'One-shot continuation' }
      }
    ])
    const sessions = (await scanAiVaultSessions({ ...roots, platform: 'win32' })).sessions
    expect(sessions.find((session) => session.sessionId === 'headless')?.isHeadless).toBe(true)
    expect(
      sessions.find((session) => session.sessionId === 'interactive')?.isHeadless
    ).toBeUndefined()
    expect(
      sessions.find((session) => session.sessionId === 'resumed-interactively')?.isHeadless
    ).toBeUndefined()
    expect(
      sessions.find((session) => session.sessionId === 'used-headlessly')?.isHeadless
    ).toBeUndefined()
  })

  it('keeps the latest real user turn after preview eviction and ignores meta or invalid times', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-human-turn-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionId = '170dd324-3d4f-40d8-8e8b-ba261c0ee064'
    await writeJsonlFile(join(roots.claudeProjectsDir, 'project', `${sessionId}.jsonl`), [
      {
        type: 'user',
        sessionId,
        timestamp: '2026-10-01T08:00:00.000Z',
        message: { role: 'user', content: 'Actual request' }
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'assistant',
        sessionId,
        timestamp: `2026-10-01T08:0${index + 1}:00.000Z`,
        message: { role: 'assistant', content: `step ${index}` }
      })),
      {
        type: 'user',
        sessionId,
        isMeta: true,
        timestamp: '2026-10-01T08:08:00.000Z',
        message: { role: 'user', content: 'Injected context' }
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-10-01T08:09:00.000Z',
        message: { role: 'user', content: '<system-reminder>internal</system-reminder>' }
      },
      {
        type: 'user',
        sessionId,
        timestamp: 'invalid',
        message: { role: 'user', content: 'No valid turn clock' }
      },
      {
        type: 'user',
        sessionId,
        timestamp: '2026-10-01T08:10:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Tool output' }]
        }
      }
    ])
    const session = (await scanAiVaultSessions({ ...roots, platform: 'win32' })).sessions.find(
      (candidate) => candidate.sessionId === sessionId
    )
    expect(session?.lastHumanTurnAt).toBe('2026-10-01T08:00:00.000Z')
    expect(session?.previewMessages.some((message) => message.text === 'Actual request')).toBe(
      false
    )
  })
  it('records only an explicit background /resume result on a launcher transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-resume-link-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')
    const launcherId = '8b1a93a0-1576-43df-88ba-5b3e742e8496'
    const targetId = '170dd324-3d4f-40d8-8e8b-ba261c0ee064'
    await writeJsonlFile(join(projectDir, `${launcherId}.jsonl`), [
      { type: 'last-prompt', sessionId: launcherId },
      {
        type: 'system',
        subtype: 'local_command',
        sessionId: launcherId,
        commandRun: { command: 'resume', args: '' },
        content:
          '<local-command-stdout>Opening "Existing chat", running in the background (170dd324)</local-command-stdout>'
      }
    ])
    await writeJsonlFile(join(projectDir, `${targetId}.jsonl`), [
      {
        type: 'user',
        sessionId: targetId,
        timestamp: '2026-10-01T08:00:00.000Z',
        cwd: '/clients/Acme',
        message: { role: 'user', content: 'Continue this chat' }
      }
    ])
    await writeJsonlFile(join(projectDir, 'unrelated.jsonl'), [
      {
        type: 'system',
        subtype: 'local_command',
        sessionId: 'unrelated',
        commandRun: { command: 'help', args: '' },
        content:
          '<local-command-stdout>Opening "Existing chat", running in the background (170dd324)</local-command-stdout>'
      }
    ])
    await writeJsonlFile(join(projectDir, 'superseded.jsonl'), [
      {
        type: 'system',
        subtype: 'local_command',
        sessionId: 'superseded',
        commandRun: { command: 'resume', args: '' },
        content:
          '<local-command-stdout>Opening "Old chat", running in the background (170dd324)</local-command-stdout>'
      },
      {
        type: 'system',
        subtype: 'local_command',
        sessionId: 'superseded',
        commandRun: { command: 'resume', args: '' },
        content: '<local-command-stdout>Resume canceled</local-command-stdout>'
      }
    ])
    const result = await scanAiVaultSessions({ ...roots, platform: 'win32' })
    expect(result.sessions.find((session) => session.sessionId === launcherId)).toMatchObject({
      messageCount: 0,
      resumedSessionIdPrefix: '170dd324'
    })
    expect(result.sessions.find((session) => session.sessionId === targetId)).not.toHaveProperty(
      'resumedSessionIdPrefix'
    )
    expect(result.sessions.find((session) => session.sessionId === 'unrelated')).not.toHaveProperty(
      'resumedSessionIdPrefix'
    )
    expect(
      result.sessions.find((session) => session.sessionId === 'superseded')
    ).not.toHaveProperty('resumedSessionIdPrefix')
  })

  it('prefers the latest generated ai-title over the first user prompt, but a custom-title wins over both', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-ai-title-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const projectDir = join(roots.claudeProjectsDir, 'project')

    await writeJsonlFile(join(projectDir, 'generated.jsonl'), [
      {
        type: 'user',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:01:00.000Z',
        aiTitle: 'Understanding karma and moral accountability'
      },
      {
        type: 'ai-title',
        sessionId: 'generated',
        timestamp: '2026-05-01T10:02:00.000Z',
        aiTitle: 'Updated karma discussion title'
      }
    ])
    await writeJsonlFile(join(projectDir, 'custom.jsonl'), [
      {
        type: 'user',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: 'First user prompt' }
      },
      {
        type: 'ai-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:01:00.000Z',
        aiTitle: 'Generated title that must lose'
      },
      {
        type: 'custom-title',
        sessionId: 'custom',
        timestamp: '2026-05-01T11:02:00.000Z',
        customTitle: 'User set title'
      }
    ])

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Updated karma discussion title',
      'User set title'
    ])
  })
})
