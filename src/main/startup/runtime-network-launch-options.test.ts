import { expect, it } from 'vitest'
import { runtimeNetworkLaunchOptions } from './runtime-network-launch-options'

it('keeps ordinary desktops on loopback and explicit servers network accessible', () => {
  expect(runtimeNetworkLaunchOptions(false, false, {})).toEqual({ exposeNetworkByDefault: false })
  expect(runtimeNetworkLaunchOptions(true, false, {})).toEqual({ exposeNetworkByDefault: true })
})

it('pins isolated UI fixtures to loopback even after a fixture pairs a device', () => {
  expect(runtimeNetworkLaunchOptions(false, true, {})).toEqual({
    exposeNetworkByDefault: false,
    pinnedBindHost: '127.0.0.1'
  })
  expect(runtimeNetworkLaunchOptions(true, true, {})).toEqual({
    exposeNetworkByDefault: false,
    pinnedBindHost: '127.0.0.1'
  })
})

it('pins background desktop package tests to loopback without disabling serve mode', () => {
  expect(runtimeNetworkLaunchOptions(false, false, { ORCA_BACKGROUND_LAUNCH: '1' })).toEqual({
    exposeNetworkByDefault: false,
    pinnedBindHost: '127.0.0.1'
  })
  expect(runtimeNetworkLaunchOptions(true, false, { ORCA_BACKGROUND_LAUNCH: '1' })).toEqual({
    exposeNetworkByDefault: true
  })
})

it('allows a network fixture only by opt-in and ignores that option on production servers', () => {
  expect(runtimeNetworkLaunchOptions(false, true, { ORCA_E2E_NETWORK_EXPOSED: '1' })).toEqual({
    exposeNetworkByDefault: true
  })
  expect(runtimeNetworkLaunchOptions(true, false, { ORCA_E2E_NETWORK_EXPOSED: '1' })).toEqual({
    exposeNetworkByDefault: true
  })
})
