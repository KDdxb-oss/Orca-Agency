import type { TuiAgentConfig } from './tui-agent-config-types'

export function getTuiAgentLaunchCommand(
  config: TuiAgentConfig,
  platform: NodeJS.Platform,
  opts?: { isRemote?: boolean }
): string {
  // Local Orca CLI naming must not leak to Linux remotes.
  if (opts?.isRemote && platform === 'linux') {
    return config.launchCmd
  }
  if (opts?.isRemote && platform === 'win32' && config.detectCmd === 'codex') {
    return config.launchCmd
  }
  return config.launchCmdByPlatform?.[platform] ?? config.launchCmd
}
