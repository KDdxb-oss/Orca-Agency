import type { GlobalSettings } from '../../shared/global-settings-types'
import { codexHomePathsEqual } from '../ipc/pty/host-env/codex-home'
import {
  getSelectedCodexAccountIdForTarget,
  type CodexAccountSelectionTarget
} from './runtime-selection'

type CodexSelectionSettings = Pick<
  GlobalSettings,
  'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime'
>

// Why: Windows' default launch mirror and trusted system history serve the same selection.
export function isSystemDefaultCodexHomeEquivalent(args: {
  target: CodexAccountSelectionTarget
  settings: CodexSelectionSettings | undefined
  hasCustomHome: boolean
  verifiedHome: string
  currentHome: string | null
  systemHome: string
  sharedHome: string
}): boolean {
  return Boolean(
    args.target.runtime === 'host' &&
    args.settings &&
    getSelectedCodexAccountIdForTarget(args.settings, args.target) === null &&
    !args.hasCustomHome &&
    codexHomePathsEqual(args.verifiedHome, args.systemHome) &&
    codexHomePathsEqual(args.currentHome, args.sharedHome)
  )
}
