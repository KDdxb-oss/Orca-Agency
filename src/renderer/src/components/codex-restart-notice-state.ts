type CodexRestartNoticeState =
  | {
      restartRequested?: true
      dismissed?: true
      homeRouteChanged?: true
      previousAccountId?: string | null
      nextAccountId?: string | null
    }
  | null
  | undefined

function isUsableCodexConfigurationNotice(notice: CodexRestartNoticeState): boolean {
  // A configuration migration does not justify interrupting an existing conversation.
  return Boolean(
    notice?.homeRouteChanged &&
    !notice.restartRequested &&
    notice.previousAccountId !== undefined &&
    notice.nextAccountId !== undefined &&
    notice.previousAccountId === notice.nextAccountId
  )
}

/**
 * True while the pane must not accept keystrokes.
 *
 * Why the two answered states differ: a requested restart still leaves the pane
 * running under the old account until it actually relaunches, so its input stays
 * blocked. A dismissal is the user choosing to keep that account, so blocking
 * their keyboard would punish them for answering.
 */
export function blocksCodexPaneInput(notice: CodexRestartNoticeState): boolean {
  return Boolean(notice) && !notice?.dismissed && !isUsableCodexConfigurationNotice(notice)
}

/** True while the restart prompt still has an unanswered question for the user. */
export function awaitsCodexRestartAnswer(notice: CodexRestartNoticeState): boolean {
  return blocksCodexPaneInput(notice) && !notice?.restartRequested
}
