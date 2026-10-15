import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FILL_ROWS = 6_000
const FLOOD_ROWS = 4_000
const TITLE_FRAME_INTERVAL_MS = 70
const TITLE_FRAME_COUNT = 30
const TITLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(fixturePath: string, marker: string): string {
  const command = [process.execPath, fixturePath, marker]
  return process.platform === 'win32'
    ? `& ${command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')}`
    : command.map(shellQuote).join(' ')
}

export function createPairedTerminalParkingFixture(): {
  command: (marker: string) => string
  dispose: () => void
} {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-retention-memory-'))
  const fixturePath = path.join(scratch, 'paired-retention-memory.mjs')
  writeFileSync(
    fixturePath,
    [
      'const marker = process.argv[2]',
      'process.stdout.write(`READY:${marker}\\r\\n`)',
      'process.stdin.setRawMode?.(true)',
      "process.stdin.setEncoding('utf8')",
      "let input = ''",
      'async function writeBurst(prefix, count, done) {',
      '  for (let row = 0; row < count; row += 1) {',
      "    const line = `${prefix}-${row}-${'x'.repeat(80)}\\r\\n`",
      "    if (!process.stdout.write(line)) await new Promise((resolve) => process.stdout.once('drain', resolve))",
      '  }',
      '  await new Promise((resolve) => process.stdout.write(`${done}\\r\\n`, resolve))',
      '}',
      "process.stdin.on('data', async (data) => {",
      '  input += data',
      '  const commands = input.split(/\\r\\n|\\r|\\n/)',
      "  input = commands.pop() ?? ''",
      '  for (const command of commands.filter(Boolean)) {',
      "    if (command.startsWith('TITLE_START:')) {",
      "      const token = command.slice('TITLE_START:'.length)",
      "      process.stdout.write('\\u001b]0;⠋ Cursor Agent\\u0007')",
      '      process.stdout.write(`TITLE_STARTED:${token}\\r\\n`)',
      '      continue',
      '    }',
      "    if (command.startsWith('TITLE_ANIMATE:')) {",
      "      const token = command.slice('TITLE_ANIMATE:'.length)",
      `      const frames = ${JSON.stringify(TITLE_FRAMES)}`,
      '      let frameIndex = 0',
      '      const emitFrame = () => {',
      `        if (frameIndex < ${TITLE_FRAME_COUNT}) {`,
      '          process.stdout.write(`\\u001b]0;${frames[frameIndex % frames.length]} Cursor Agent\\u0007`)',
      '          frameIndex += 1',
      `          setTimeout(emitFrame, ${TITLE_FRAME_INTERVAL_MS})`,
      '          return',
      '        }',
      "        process.stdout.write('\\u001b]0;Cursor ready\\u0007')",
      '        process.stdout.write(`TITLE_DONE:${token}\\r\\n`)',
      '      }',
      `      setTimeout(emitFrame, ${TITLE_FRAME_INTERVAL_MS})`,
      '      continue',
      '    }',
      "    if (command.startsWith('FLOOD:')) {",
      "      const token = command.slice('FLOOD:'.length)",
      `      await writeBurst('flood-' + token, ${FLOOD_ROWS}, 'FLOODED:' + token)`,
      '      continue',
      '    }',
      "    if (command === 'FILL') {",
      `      await writeBurst('fill-' + marker, ${FILL_ROWS}, 'FILLED:' + marker)`,
      '      continue',
      '    }',
      '    process.stdout.write(`LIVE:${command}\\r\\n`)',
      '  }',
      '})',
      'process.stdin.resume()'
    ].join('\n')
  )
  return {
    command: (marker) => fixtureCommand(fixturePath, marker),
    dispose: () => rmSync(scratch, { recursive: true, force: true })
  }
}
