import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'

export type NotificationDismissalWriteRequest = { id: number; path: string; value: unknown }
export type NotificationDismissalWriteResponse = { id: number; ok: boolean; error?: string }

function defaultWorkerFactory(): Worker {
  const entry = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'notification-dismissal-worker-entry.js'
  )
  if (!existsSync(entry)) {
    throw new Error('Notification dismissal writer entry is missing')
  }
  return new Worker(entry)
}

/** Preserve secure-file's ACL-before-publish contract while its Windows commands run off main. */
export function createNotificationDismissalWriter(
  factory: WorkerThreadFactory = defaultWorkerFactory
): (path: string, value: unknown) => Promise<void> {
  const queue = new WorkerThreadRequestQueue<
    NotificationDismissalWriteRequest,
    NotificationDismissalWriteResponse
  >({
    factory,
    idleTeardownMs: 60_000,
    maxConsecutiveDeaths: 1,
    queueCap: {
      maxQueuedCalls: 2,
      describeFull: () => 'Notification dismissal writer queue is full'
    },
    createUnavailableError: (message) => new Error(message),
    describeTimeout: () => 'Notification dismissal persistence timed out',
    describeExit: (code) => `Notification dismissal writer exited (${code})`,
    describeCrashLoop: () => 'Notification dismissal writer failed repeatedly',
    onUnavailable: () => console.warn('[notifications] Background dismissal writer unavailable')
  })
  return async (path, value) => {
    const response = await queue.dispatch((id) => ({ id, path, value }), 60_000)
    if (!response.ok) {
      throw new Error(response.error ?? 'Notification dismissal write failed')
    }
  }
}

const sharedWriter = createNotificationDismissalWriter()
export const writeNotificationDismissals = sharedWriter
