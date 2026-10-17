export function runtimeNetworkLaunchOptions(
  serve: boolean,
  isolatedTest: boolean,
  env: NodeJS.ProcessEnv = process.env
): { exposeNetworkByDefault: boolean; pinnedBindHost?: string } {
  // Each background packaged build has a new path, so a LAN bind prompts Windows Firewall again.
  if (
    (isolatedTest || (!serve && env.ORCA_BACKGROUND_LAUNCH === '1')) &&
    env.ORCA_E2E_NETWORK_EXPOSED !== '1'
  ) {
    return { exposeNetworkByDefault: false, pinnedBindHost: '127.0.0.1' }
  }
  return { exposeNetworkByDefault: serve || isolatedTest }
}
