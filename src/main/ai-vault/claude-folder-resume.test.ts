import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareClaudeFolderResume } from './claude-folder-resume'
import { encodeClaudeProjectPath } from '../../shared/claude-project-path'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orca-claude-folder-'))
  roots.push(root)
  const projects = path.join(root, 'projects')
  const oldBucket = path.join(projects, 'old-folder')
  const cwd = path.join(root, 'Actual folder')
  await mkdir(oldBucket, { recursive: true })
  await mkdir(cwd)
  const filePath = path.join(oldBucket, 'session-123.jsonl')
  const contents =
    '{"type":"user","sessionId":"session-123","message":{"role":"user","content":"Keep my conversation"}}\n'
  await writeFile(filePath, contents)
  return {
    root,
    cwd,
    projects,
    contents,
    args: {
      agent: 'claude' as const,
      sessionId: 'session-123',
      filePath,
      codexHome: null,
      executionHostId: 'local' as const,
      resumeCwd: cwd
    }
  }
}

describe('Claude chat folder resume preparation', () => {
  it('preserves the original and session identity in the actual destination bucket', async () => {
    const f = await fixture()
    const companion = path.join(path.dirname(f.args.filePath), f.args.sessionId, 'subagents')
    await mkdir(companion, { recursive: true })
    await writeFile(path.join(companion, 'agent-1.jsonl'), 'subagent history')
    const result = await prepareClaudeFolderResume(f.args)
    const filePath = path.join(f.projects, encodeClaudeProjectPath(f.cwd), 'session-123.jsonl')
    expect(result.relocatedClaudeSession).toEqual({ cwd: f.cwd, filePath })
    expect(await readFile(filePath, 'utf8')).toBe(f.contents)
    expect(await readFile(f.args.filePath, 'utf8')).toBe(f.contents)
    expect(
      await readFile(
        path.join(path.dirname(filePath), f.args.sessionId, 'subagents', 'agent-1.jsonl'),
        'utf8'
      )
    ).toBe('subagent history')
    expect(await prepareClaudeFolderResume(f.args)).toEqual(result)
  })
  it('explains a missing transcript without creating a replacement conversation', async () => {
    const f = await fixture()
    await expect(
      prepareClaudeFolderResume({ ...f.args, filePath: path.join(f.projects, 'missing.jsonl') })
    ).rejects.toThrow('The saved Claude conversation file is missing')
  })
  it('uses the real folder behind a junction or symbolic link', async () => {
    const f = await fixture()
    const alias = path.join(f.root, 'Shortcut')
    await symlink(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const result = await prepareClaudeFolderResume({ ...f.args, resumeCwd: alias })
    expect(result.relocatedClaudeSession?.cwd).toBe(f.cwd)
    expect(result.relocatedClaudeSession?.filePath).toContain(encodeClaudeProjectPath(f.cwd))
  })
  it('refuses to overwrite a different saved continuation', async () => {
    const f = await fixture()
    const first = await prepareClaudeFolderResume(f.args)
    await writeFile(first.relocatedClaudeSession!.filePath, 'newer saved history')
    await expect(prepareClaudeFolderResume(f.args)).rejects.toThrow('another saved version')
    expect(await readFile(first.relocatedClaudeSession!.filePath, 'utf8')).toBe(
      'newer saved history'
    )
    expect(await readFile(f.args.filePath, 'utf8')).toBe(f.contents)
  })
  it('reopens the continued destination when the saved list still points at the original', async () => {
    const f = await fixture()
    const first = await prepareClaudeFolderResume(f.args)
    const continuation =
      '{"type":"assistant","sessionId":"session-123","message":{"content":"Next turn"}}\n'
    await writeFile(first.relocatedClaudeSession!.filePath, f.contents + continuation)
    expect((await prepareClaudeFolderResume(f.args)).relocatedClaudeSession).toEqual(
      first.relocatedClaudeSession
    )
    expect(await readFile(f.args.filePath, 'utf8')).toBe(f.contents)
  })
  it('allows a provider filename alias when reopening in the same canonical folder', async () => {
    const f = await fixture()
    const bucket = path.join(f.projects, encodeClaudeProjectPath(f.cwd))
    await mkdir(bucket)
    const alias = path.join(bucket, 'provider-file-alias.jsonl')
    await writeFile(alias, f.contents)
    expect(
      (await prepareClaudeFolderResume({ ...f.args, filePath: alias })).relocatedClaudeSession
    ).toEqual({ cwd: f.cwd, filePath: alias })
  })
  it('rejects an unrelated file or a missing folder', async () => {
    const f = await fixture()
    await expect(
      prepareClaudeFolderResume({ ...f.args, sessionId: '../different' })
    ).rejects.toThrow('Invalid')
    await expect(prepareClaudeFolderResume({ ...f.args, sessionId: 'different' })).rejects.toThrow(
      'different file identity'
    )
    await expect(
      prepareClaudeFolderResume({ ...f.args, resumeCwd: path.join(f.root, 'missing') })
    ).rejects.toThrow('The selected chat folder no longer exists')
  })
})
