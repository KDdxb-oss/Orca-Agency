export function hasCompatibleDesktopUpdateFeed(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  // The existing Windows feeds publish x64 installers only.
  return platform !== 'win32' || architecture !== 'arm64'
}
