import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { autoUpdaterMock, powerMonitorOnMock, fetchNudgeMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
vi.mock('./updater/windows-arm64-update-policy', () => ({
  hasCompatibleDesktopUpdateFeed: () => false
}))

warmUpdaterModule()

describe('reviewed weekly desktop updates', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  it('keeps checks, downloads and installs quiet without accessing an incompatible feed', async () => {
    const send = vi.fn()
    const updater = await loadUpdaterModule()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The updater only reads webContents.send from this window double.
    updater.setupAutoUpdater({ webContents: { send } } as never)
    updater.checkForUpdates()
    updater.checkForUpdatesFromMenu()
    updater.downloadUpdate()
    updater.quitAndInstall()

    expect(updater.getUpdateStatus()).toEqual({ state: 'idle' })
    expect(
      send.mock.calls.every(
        ([channel, status]) =>
          channel === 'updater:quitAndInstallAborted' ||
          (channel === 'updater:status' && status.state === 'idle')
      )
    ).toBe(true)
    expect(
      send.mock.calls.filter(([channel]) => channel === 'updater:quitAndInstallAborted')
    ).toEqual([['updater:quitAndInstallAborted']])
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(fetchNudgeMock).not.toHaveBeenCalled()
    expect(powerMonitorOnMock).not.toHaveBeenCalled()
  })
})
