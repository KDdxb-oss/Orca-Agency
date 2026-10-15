import { webContents, type BrowserWindow } from 'electron'

export function installMainWindowMouseHistory(
  mainWindow: {
    on: (
      event: 'app-command',
      listener: (event: Pick<Electron.Event, 'preventDefault'>, command: string) => void
    ) => unknown
    webContents: Pick<BrowserWindow['webContents'], 'id' | 'send'>
  },
  platform: NodeJS.Platform = process.platform,
  focusedContentsId: () => number | undefined = () => webContents.getFocusedWebContents()?.id
): void {
  if (platform !== 'win32' && platform !== 'linux') {
    return
  }
  mainWindow.on('app-command', (event, command) => {
    const direction =
      command === 'browser-backward' ? 'back' : command === 'browser-forward' ? 'forward' : null
    // Browser guests retain their own page history when they own focus.
    if (!direction || focusedContentsId() !== mainWindow.webContents.id) {
      return
    }
    event.preventDefault()
    mainWindow.webContents.send('ui:worktreeHistoryNavigate', direction)
  })
}
