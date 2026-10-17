// The one fake in a provider replay: an in-memory child process. The real connection writes JSON
// lines to its stdin and reads the recorded frames from its stdout.

import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { spawnProcess } from '../../shared/child-process/run-process'

export type ReplayChildWrite = (frame: unknown) => void

/** A `spawnImpl` whose every spawn is a fresh in-memory child; `onFrame` sees each stdin line and
 *  answers through `write`, that child's stdout. The child exits when its stdin ends or on kill. */
export function replayChildSpawn(
  onFrame: (frame: Record<string, unknown>, write: ReplayChildWrite) => void
): typeof spawnProcess {
  return () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let exited = false
    // The Agent SDK refuses to write to a child whose exitCode is anything but null.
    const status: { exitCode: number | null; killed: boolean } = { exitCode: null, killed: false }
    const child = Object.assign(new EventEmitter(), status, {
      // Outside any real process table so teardown never mistakes an unrelated process for it.
      pid: 9_999_999,
      stdin,
      stdout,
      stderr,
      kill: (signal?: NodeJS.Signals): boolean => {
        child.killed = true
        exit(null, signal ?? 'SIGTERM')
        return true
      }
    })
    function exit(code: number | null, signal: NodeJS.Signals | null): void {
      if (exited) {
        return
      }
      exited = true
      child.exitCode = code
      stdout.end()
      stderr.end()
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    }
    const write: ReplayChildWrite = (frame) => {
      if (!exited) {
        stdout.write(`${JSON.stringify(frame)}\n`)
      }
    }
    stdin.on('finish', () => exit(0, null))
    createInterface({ input: stdin }).on('line', (line) => {
      const frame: unknown = JSON.parse(line)
      if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) {
        onFrame(Object.fromEntries(Object.entries(frame)), write)
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connection reads only pid, the three pipes, kill and the exit/close/error events, which this fake carries.
    return child as unknown as ReturnType<typeof spawnProcess>
  }
}

/** Resolves once `ready()` holds; a frame written to stdout reaches its handler a few ticks on. */
export async function replayUntil(ready: () => boolean): Promise<void> {
  while (!ready()) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
