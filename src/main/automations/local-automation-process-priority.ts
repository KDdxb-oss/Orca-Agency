import { constants, setPriority } from 'node:os'
import { listRegisteredPtys } from '../memory/pty-registry'
import {
  isWindowsProcessTableAvailable,
  readWindowsProcessIdentityTableFresh
} from '../windows/windows-process-table'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'

export function automationProcessTreePids(
  rootPid: number,
  rows: readonly Pick<WindowsProcessIdentityRow, 'pid' | 'ppid'>[]
): number[] {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? []
    siblings.push(row.pid)
    children.set(row.ppid, siblings)
  }
  const pending = [...(children.get(rootPid) ?? [])]
  const visited = new Set<number>([rootPid])
  const descendants: number[] = []
  while (pending.length) {
    const pid = pending.pop()
    if (pid === undefined || visited.has(pid)) {
      continue
    }
    visited.add(pid)
    descendants.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return descendants
}

/** Keep automation terminal work behind interactive Windows work, including spawned tools. */
export async function lowerLocalAutomationProcessPriority(ptyId: string | null): Promise<void> {
  if (process.platform !== 'win32' || !ptyId) {
    return
  }
  const rootPid = listRegisteredPtys().find((pty) => pty.ptyId === ptyId)?.pid
  if (!rootPid) {
    return
  }
  const lower = (pid: number): void => {
    try {
      setPriority(pid, constants.priority.PRIORITY_LOW)
    } catch {
      // A process can exit between the snapshot and the priority change.
    }
  }
  lower(rootPid)
  if (!isWindowsProcessTableAvailable()) {
    return
  }
  try {
    const rows = await readWindowsProcessIdentityTableFresh()
    for (const pid of automationProcessTreePids(rootPid, rows)) {
      lower(pid)
    }
  } catch {
    // The terminal root still runs at low priority if process inventory is unavailable.
  }
}

/** Agent subprocesses can start after the first process snapshot. Recheck startup only. */
export function scheduleLocalAutomationPriorityFollowups(
  ptyId: string | null,
  stillOwnsPty: () => boolean,
  lower: (id: string) => Promise<void> = lowerLocalAutomationProcessPriority
): void {
  if (process.platform !== 'win32' || !ptyId) {
    return
  }
  for (const delayMs of [1_000, 10_000]) {
    const timer = setTimeout(() => {
      try {
        if (stillOwnsPty()) {
          void lower(ptyId).catch(() => {})
        }
      } catch {
        // The runtime can close while a delayed check is pending.
      }
    }, delayMs)
    timer.unref()
  }
}
