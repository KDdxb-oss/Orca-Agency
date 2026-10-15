import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { getRepoExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'

export type FolderStatusStore = Pick<Store, 'getRepos'> & {
  getAllWorktreeMeta(): Record<string, unknown>
}

/** Registered folder ownership never requires asking the remote Git provider. */
export function isRegisteredSshFolderStatus(
  store: FolderStatusStore,
  worktreePath: string,
  connectionId: string
): boolean {
  const path = normalizeRuntimePathForComparison(worktreePath)
  const hostId = toSshExecutionHostId(connectionId)
  const folders = store
    .getRepos()
    .filter((repo) => getRepoExecutionHostId(repo) === hostId && isFolderRepo(repo))
  if (folders.length === 0) {
    return false
  }
  if (folders.some((repo) => normalizeRuntimePathForComparison(repo.path) === path)) {
    return true
  }
  const ids = new Set(folders.map((repo) => repo.id))
  return Object.keys(store.getAllWorktreeMeta()).some((id) => {
    const parsed = splitWorktreeIdForFilesystem(id)
    return (
      !!parsed &&
      ids.has(parsed.repoId) &&
      normalizeRuntimePathForComparison(parsed.worktreePath) === path
    )
  })
}
