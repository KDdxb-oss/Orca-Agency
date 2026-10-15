import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Diagnostic disk stalls must not block main or create an unbounded pending queue. */
export function createMainThreadFileCapture(
  path: string,
  append: (path: string, line: string) => Promise<void> = appendBounded
): (line: string) => void {
  let pending: string | null = null
  let active = false
  return (line) => {
    pending = `${line}\n`
    if (active) {
      return
    }
    active = true
    void (async () => {
      while (pending !== null) {
        const next = pending
        pending = null
        try {
          await append(path, next)
        } catch {
          // A failed diagnostic write must not affect the app or retry continuously.
        }
      }
      active = false
    })()
  }
}

async function appendBounded(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const existing = await stat(path).catch(() => null)
  if (existing && existing.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
    // Refuse the append if rotation fails, keeping disk use bounded.
    await rename(path, `${path}.previous`)
  }
  await appendFile(path, line, { mode: 0o600 })
}
