import { expect, it } from 'vitest'
import { runtimeNetworkLaunchOptions } from './runtime-network-launch-options'

it('keeps ordinary desktops on loopback and explicit servers network accessible', () => {
  expect(runtimeNetworkLaunchOptions(false, false, {})).toEqual({ exposeNetworkByDefault: false })
  expect(runtimeNetworkLaunchOptions(true, false, {})).toEqual({ exposeNetworkByDefault: true })
})

it('pins explicitly local UI fixtures to loopback even after a fixture pairs a device', () => {
  expect(runtimeNetworkLaunchOptions(false, true, { ORCA_E2E_LOOPBACK_ONLY: '1' })).toEqual({
    exposeNetworkByDefault: false,
    pinnedBindHost: '127.0.0.1'
  })
  expect(runtimeNetworkLaunchOptions(true, true, { ORCA_E2E_LOOPBACK_ONLY: '1' })).toEqual({
    exposeNetworkByDefault: false,
    pinnedBindHost: '127.0.0.1'
  })
})

it('retains network fixtures and ignores the test option on production servers', () => {
  expect(runtimeNetworkLaunchOptions(false, true, {})).toEqual({ exposeNetworkByDefault: true })
  expect(runtimeNetworkLaunchOptions(true, false, { ORCA_E2E_LOOPBACK_ONLY: '1' })).toEqual({
    exposeNetworkByDefault: true
  })
})
