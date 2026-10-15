import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent')

afterEach(() => vi.restoreAllMocks())

function consoleListFor(innerPid = 4321) {
  const agent = Object.create(WindowsPtyAgent.prototype)
  agent._innerPid = innerPid
  return agent._getConsoleProcessList()
}

describe('node-pty console-list helper failure cleanup', () => {
  it('falls back when creating the helper throws', async () => {
    vi.spyOn(childProcess, 'fork').mockImplementation(() => {
      throw new Error('resource exhausted')
    })
    await expect(consoleListFor()).resolves.toEqual([4321])
  })

  it('falls back when the helper reports an asynchronous spawn error', async () => {
    const helper = new EventEmitter()
    helper.kill = vi.fn()
    vi.spyOn(childProcess, 'fork').mockReturnValue(helper)
    const result = consoleListFor()
    helper.emit('error', new Error('EAGAIN'))
    await expect(result).resolves.toEqual([4321])
  })

  it('uses the helper result and tolerates its later exit', async () => {
    const helper = new EventEmitter()
    helper.kill = vi.fn()
    vi.spyOn(childProcess, 'fork').mockReturnValue(helper)
    const result = consoleListFor()
    helper.emit('message', { consoleProcessList: [4321, 9876] })
    helper.emit('exit', 0)
    await expect(result).resolves.toEqual([4321, 9876])
  })
})
