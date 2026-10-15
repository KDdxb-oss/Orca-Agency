import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWorkspaceShortcutIpcBridge } from './workspace-shortcut-ipc-bridge'

const store = vi.hoisted(() => ({
  activeView: 'terminal',
  activeModal: 'none',
  goBackWorktree: vi.fn(),
  goForwardWorktree: vi.fn()
}))

vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))

describe('workspace history shortcut admission', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    store.activeView = 'terminal'
    store.activeModal = 'none'
  })

  function register(): (direction: 'back' | 'forward') => boolean {
    let navigate: (direction: 'back' | 'forward') => boolean = () => false
    vi.stubGlobal('window', {
      navigator: { userAgent: 'Windows' },
      api: {
        ui: new Proxy(
          {},
          {
            get: (_target, method) =>
              method === 'onWorktreeHistoryNavigate'
                ? (callback: typeof navigate) => {
                    navigate = callback
                    return () => {}
                  }
                : () => () => {}
          }
        )
      }
    })
    registerWorkspaceShortcutIpcBridge([])
    return (direction) => navigate(direction)
  }

  it('uses the existing history actions with the actual idle modal value', () => {
    const navigate = register()
    expect(navigate('back')).toBe(true)
    expect(navigate('forward')).toBe(true)
    expect(store.goBackWorktree).toHaveBeenCalledTimes(1)
    expect(store.goForwardWorktree).toHaveBeenCalledTimes(1)
  })

  it('does not navigate behind an open modal', () => {
    const navigate = register()
    store.activeModal = 'quick-open'
    expect(navigate('back')).toBe(false)
    expect(store.goBackWorktree).not.toHaveBeenCalled()
  })

  it('matches toolbar availability outside the terminal view', () => {
    const navigate = register()
    store.activeView = 'tasks'
    expect(navigate('back')).toBe(true)
    store.activeView = 'settings'
    expect(navigate('forward')).toBe(false)
    expect(store.goForwardWorktree).not.toHaveBeenCalled()
  })
})
