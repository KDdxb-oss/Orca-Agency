import { describe, expect, it } from 'vitest'
import { resolveBareAgentLaunchCommand } from './runtime-agent-launch-resolution'

describe('resolveBareAgentLaunchCommand', () => {
  it('recognizes both saved and new Codex commands on local Windows', () => {
    const settings = {}
    expect(
      resolveBareAgentLaunchCommand({
        command: 'codex',
        settings,
        platform: 'win32',
        isRemote: false
      })
    ).toBe('codex')
    expect(
      resolveBareAgentLaunchCommand({
        command: 'codex --no-alt-screen',
        settings,
        platform: 'win32',
        isRemote: false
      })
    ).toBe('codex')
  })

  it('does not mistake the Linux Orca screen reader for the agent CLI', () => {
    expect(
      resolveBareAgentLaunchCommand({
        command: 'orca',
        settings: {},
        platform: 'linux',
        isRemote: false
      })
    ).toBeNull()
  })
})
