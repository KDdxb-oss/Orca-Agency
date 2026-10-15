export function runtimeNetworkLaunchOptions(
  serve: boolean,
  isolatedTest: boolean,
  env: NodeJS.ProcessEnv = process.env
): { exposeNetworkByDefault: boolean; pinnedBindHost?: string } {
  if (isolatedTest && env.ORCA_E2E_LOOPBACK_ONLY === '1') {
    return { exposeNetworkByDefault: false, pinnedBindHost: '127.0.0.1' }
  }
  return { exposeNetworkByDefault: serve || isolatedTest }
}
