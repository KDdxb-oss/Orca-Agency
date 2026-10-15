export function scheduleRestoredMailboxRepoints(
  handles: Iterable<string>,
  routeDirect: (handle: string) => {
    mailboxes: readonly { mailboxHandle: string }[]
    hasMore: boolean
  },
  schedule: (handle: string) => void
): void {
  for (const handle of handles) {
    try {
      if (handle.startsWith('run:') || handle.startsWith('dispatch:')) {
        schedule(handle)
        continue
      }
      const routed = routeDirect(handle)
      for (const mailbox of routed.mailboxes) {
        schedule(mailbox.mailboxHandle)
      }
      if (!routed.hasMore) {
        schedule(handle)
      }
    } catch (error) {
      console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
      schedule(handle)
    }
  }
}
