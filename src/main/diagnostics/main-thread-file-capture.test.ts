import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createMainThreadFileCapture } from './main-thread-file-capture'

it('bounds pending diagnostic lines while a disk write is blocked', async () => {
  const releases: (() => void)[] = []
  const append = vi.fn(
    (_path: string, _line: string) => new Promise<void>((resolve) => releases.push(resolve))
  )
  const capture = createMainThreadFileCapture('fixture', append)
  capture('first')
  for (let i = 0; i < 100; i++) {
    capture(String(i))
  }
  expect(append).toHaveBeenCalledOnce()
  releases.shift()!()
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2))
  expect(append.mock.calls[1][1]).toBe('99\n')
  releases.shift()!()
})

it('recovers on a new sample after a failed write without a retry loop', async () => {
  const append = vi
    .fn()
    .mockRejectedValueOnce(new Error('Disk unavailable'))
    .mockResolvedValue(undefined)
  const capture = createMainThreadFileCapture('fixture', append)
  capture('first')
  await Promise.resolve()
  expect(append).toHaveBeenCalledOnce()
  capture('second')
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2))
})

it('rotates bounded logs and records new samples in the current file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-main-diagnostic-'))
  try {
    const path = join(dir, 'main.jsonl')
    const capture = createMainThreadFileCapture(path)
    capture('x'.repeat(5 * 1024 * 1024 - 1))
    await vi.waitFor(async () => expect((await stat(path)).size).toBe(5 * 1024 * 1024))
    capture('next')
    await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('next\n'))
    expect((await stat(`${path}.previous`)).size).toBe(5 * 1024 * 1024)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
