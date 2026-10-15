import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'

type ReplayedScrollbackReleaseArgs = {
  hasScrollbackRefs: boolean
  worktreeId: string | undefined
  repos: readonly RepoConnection[]
}

/** Keep the only saved copy until a later park replaces it; startup can remount before recapture. */
export function canReleaseReplayedScrollbackFromStore({
  hasScrollbackRefs
}: ReplayedScrollbackReleaseArgs): boolean {
  return hasScrollbackRefs
}
