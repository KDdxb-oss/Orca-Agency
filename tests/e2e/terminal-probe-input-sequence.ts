import { nodeTerminalCommand } from './terminal-node-command'

export function buildFreshShellProbeInputSequence(command: string): readonly string[] {
  // Why: Windows ConPTY can echo a startup Ctrl+C as literal "^C", which
  // corrupts the following PowerShell command before the shell is ready.
  return [command]
}

export function buildSettledShellProbeInputSequence(
  command: string,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  // Why: Ctrl+U is a POSIX line-editor binding. A settled native Windows shell
  // needs a separate Ctrl+C so ConPTY cannot join it to the command as input.
  return platform === 'win32' ? ['\x03', command] : ['\x03\x15', command]
}
export function encodedShellMarkerCommand(marker: string): string {
  // Encoding prevents terminal command echo from satisfying the readiness check.
  const encoded = Buffer.from(marker, 'utf8').toString('base64')
  return `${nodeTerminalCommand([
    '-e',
    `console.log(Buffer.from('${encoded}', 'base64').toString('utf8'))`
  ])}\r`
}
