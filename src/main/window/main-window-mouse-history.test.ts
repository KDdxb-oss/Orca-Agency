import { describe, expect, it, vi } from 'vitest'
import { installMainWindowMouseHistory } from './main-window-mouse-history'

vi.mock('electron', () => ({ webContents: { getFocusedWebContents: vi.fn() } }))

describe('mouse side-button history', () => {
  function setup(platform: NodeJS.Platform = 'win32') {
    let listener:
      | ((event: Pick<Electron.Event, 'preventDefault'>, command: string) => void)
      | undefined
    const on = vi.fn((_event: 'app-command', callback: NonNullable<typeof listener>) => {
      listener = callback
    })
    const focusedContentsId = vi.fn<() => number | undefined>(() => 1)
    const send = vi.fn()
    installMainWindowMouseHistory({ on, webContents: { id: 1, send } }, platform, focusedContentsId)
    const preventDefault = vi.fn()
    return {
      on,
      focusedContentsId,
      send,
      preventDefault,
      emit: (command: string) => listener?.({ preventDefault }, command)
    }
  }

  it.each(['win32', 'linux'] as const)('routes one backward/forward command on %s', (platform) => {
    const window = setup(platform)
    window.emit('browser-backward')
    window.emit('browser-forward')
    expect(window.send.mock.calls).toEqual([
      ['ui:worktreeHistoryNavigate', 'back'],
      ['ui:worktreeHistoryNavigate', 'forward']
    ])
    expect(window.preventDefault).toHaveBeenCalledTimes(2)
  })

  it('leaves browser guest navigation and unrelated commands alone', () => {
    const window = setup()
    window.focusedContentsId.mockReturnValue(2)
    window.emit('browser-backward')
    window.focusedContentsId.mockReturnValue(undefined)
    window.emit('browser-forward')
    window.focusedContentsId.mockReturnValue(1)
    window.emit('volume-up')
    expect(window.send).not.toHaveBeenCalled()
    expect(window.preventDefault).not.toHaveBeenCalled()
  })

  it('uses no native listener on macOS', () => {
    expect(setup('darwin').on).not.toHaveBeenCalled()
  })
})
