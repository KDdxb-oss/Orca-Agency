// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMacMouseHistory } from './mac-mouse-history'

describe('macOS mouse history fallback', () => {
  afterEach(() => vi.restoreAllMocks())

  it('routes only side buttons once and removes its listener', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const navigate = vi.fn(() => true)
    const dispose = registerMacMouseHistory(window, navigate)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
    const back = new MouseEvent('mouseup', { button: 3, cancelable: true })
    window.dispatchEvent(back)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 4 }))
    dispose()
    window.dispatchEvent(new MouseEvent('mouseup', { button: 3 }))
    expect(navigate.mock.calls).toEqual([['back'], ['forward']])
    expect(back.defaultPrevented).toBe(true)
  })

  it('does not install a competing listener on Windows or consume disabled navigation', () => {
    const userAgent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const navigate = vi.fn(() => false)
    const disposeWindows = registerMacMouseHistory(window, navigate)
    window.dispatchEvent(new MouseEvent('mouseup', { button: 3 }))
    expect(navigate).not.toHaveBeenCalled()
    disposeWindows()
    userAgent.mockReturnValue('Macintosh')
    const dispose = registerMacMouseHistory(window, navigate)
    const back = new MouseEvent('mouseup', { button: 3, cancelable: true })
    window.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(false)
    dispose()
  })
})
