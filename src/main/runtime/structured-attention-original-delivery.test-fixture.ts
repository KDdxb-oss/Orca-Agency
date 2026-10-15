import { writeFile } from 'node:fs/promises'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationDismissEvent
} from './runtime-mobile-notification-controller'

export async function captureOriginalDeliveryRetirement(directory: string): Promise<{
  originalEpoch: string
  restartedEpoch: string
  event: MobileNotificationDismissEvent
}> {
  const original = new RuntimeMobileNotificationController()
  // The mobile test runner has no packaged notification writer worker. Persist the original
  // delivery directly so the restarted controller still exercises the real recovery path.
  const persisted = new MobileNotificationDismissalStore(directory, async (path, value) => {
    await writeFile(path, JSON.stringify(value))
  })
  original.onDispatched((value) => {
    if (
      value.type === 'notification' &&
      value.notificationEpoch &&
      value.notificationSeq !== undefined
    ) {
      persisted.record({
        ...value,
        notificationEpoch: value.notificationEpoch,
        notificationSeq: value.notificationSeq
      })
    }
  })
  original.dispatch({
    type: 'notification',
    source: 'agent-task-complete',
    title: 'Allow?',
    body: '',
    notificationId: 'same',
    structuredOrigin: {
      scope: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      },
      sessionId: 'session-a',
      journalCursor: { epoch: 'journal-a', sequence: 1 },
      cause: { kind: 'prompt', promptId: 'A' }
    }
  })
  await persisted.flush()
  const restarted = new RuntimeMobileNotificationController()
  restarted.configureDismissalStore(directory)
  let event: MobileNotificationDismissEvent | undefined
  restarted.onDispatched((value) => {
    if (value.type === 'dismiss') {
      event = value
    }
  })
  restarted.retireStructuredAttention({
    sessionId: 'session-a',
    observedCursor: { epoch: 'journal-a', sequence: 1 }
  })
  if (!event) {
    throw new Error('read did not withdraw the prompt')
  }
  return { originalEpoch: original.getEpoch(), restartedEpoch: restarted.getEpoch(), event }
}
