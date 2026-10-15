import type { GitAdmissionTier } from '../../git/command-runner/git-exec-options'

export type FilesystemGitStatusRequest = {
  worktreePath: string
  connectionId?: string
  admissionTier?: GitAdmissionTier
  includeIgnored?: boolean
  includeLineStats?: boolean
  bypassEffectiveUpstreamNegativeCache?: boolean
  reuseLineStats?: boolean
  branchLineTotalMergeBase?: string
  requestToken?: string
}

export function filesystemGitStatusOptions(args: FilesystemGitStatusRequest, signal?: AbortSignal) {
  return {
    includeIgnored: args.includeIgnored ?? false,
    admissionTier: args.admissionTier ?? ('status' as const),
    ...(args.includeLineStats === false ? { includeLineStats: false } : {}),
    ...(args.reuseLineStats === true ? { reuseLineStats: true } : {}),
    ...(args.branchLineTotalMergeBase === undefined
      ? {}
      : { branchLineTotalMergeBase: args.branchLineTotalMergeBase }),
    ...(args.bypassEffectiveUpstreamNegativeCache === true
      ? { bypassEffectiveUpstreamNegativeCache: true }
      : {}),
    ...(signal ? { signal } : {})
  }
}
