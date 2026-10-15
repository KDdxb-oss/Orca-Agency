export function redriveStructuredSessionMail(
  summary: { sessionId: string; status: 'working' | 'attention' | 'idle' | null },
  onJournalActivity: (sessionId: string) => void,
  listMailboxes: (sessionId: string) => Iterable<string>,
  deliver: (mailbox: string) => void
): void {
  if (summary.status === 'working' || summary.status === 'attention') {
    return
  }
  try {
    onJournalActivity(summary.sessionId)
    for (const mailbox of listMailboxes(summary.sessionId)) {
      deliver(mailbox)
    }
  } catch (error) {
    console.warn('[orchestration] structured session mail redrive failed', {
      sessionId: summary.sessionId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
