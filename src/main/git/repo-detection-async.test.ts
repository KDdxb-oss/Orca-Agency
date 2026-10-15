import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { exec, scan } = vi.hoisted(() => ({ exec: vi.fn(), scan: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: exec }))
vi.mock('./repo-git-marker-scan', () => ({ scanGitMarkerSync: scan }))
vi.mock('./repo-detection', () => ({
  normalizeGitRepoRootForInputPath: (_: string, root: string) => root
}))
import { getGitRepoRootAsync, isGitRepoAsync } from './repo-detection-async'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-async-repo-'))
  exec.mockReset()
  scan.mockReset().mockReturnValue({ status: 'absent' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('lets main-loop work proceed while the Git process is still pending', async () => {
  let finish: (value: { stdout: string }) => void = () => {}
  exec.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const result = isGitRepoAsync(root)
  await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
  const tick = await new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0))
  expect(tick).toBe(true)
  finish({ stdout: 'true\n' })
  await expect(result).resolves.toBe(true)
})

it('preserves bare-repo detection and clean negative Git answers', async () => {
  exec.mockResolvedValueOnce({ stdout: 'false\n' }).mockResolvedValueOnce({ stdout: 'true\n' })
  await expect(isGitRepoAsync(root)).resolves.toBe(true)
  exec.mockResolvedValue({ stdout: 'false\n' })
  scan.mockReturnValue({ status: 'valid', rootPath: root })
  await expect(isGitRepoAsync(root)).resolves.toBe(false)
  expect(scan).not.toHaveBeenCalled()
})

it('keeps metadata recovery when Git fails and does not probe missing directories', async () => {
  exec.mockRejectedValue(new Error('Git unavailable'))
  scan.mockReturnValue({ status: 'valid', rootPath: root })
  await expect(isGitRepoAsync(root)).resolves.toBe(true)
  await expect(getGitRepoRootAsync(root)).resolves.toBe(root)
  exec.mockClear()
  await expect(isGitRepoAsync(join(root, 'missing'))).resolves.toBe(false)
  await expect(getGitRepoRootAsync(join(root, 'missing'))).resolves.toBe(join(root, 'missing'))
  expect(exec).not.toHaveBeenCalled()
})

it('resolves a nested directory from one asynchronous Git command', async () => {
  const nested = join(root, 'nested')
  await mkdir(nested)
  exec.mockResolvedValue({ stdout: `true\n${root}\n` })
  await expect(getGitRepoRootAsync(nested)).resolves.toBe(root)
  expect(exec).toHaveBeenCalledOnce()
  expect(scan).not.toHaveBeenCalled()
})
