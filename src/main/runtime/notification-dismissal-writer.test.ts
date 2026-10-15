import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { createNotificationDismissalWriter } from './notification-dismissal-writer'

const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
})

it('keeps the calling loop responsive while a worker is synchronously blocked', async () => {
  const write = createNotificationDismissalWriter(() => {
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads')
      parentPort.on('message', ({id}) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
        parentPort.postMessage({id, ok:true})
      })
    `,
      { eval: true }
    )
    workers.push(worker)
    return worker
  })
  let completed = false
  const pending = write('fixture', []).then(() => {
    completed = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(completed).toBe(false)
  await pending
  expect(completed).toBe(true)
})

it('reports writer failures rather than retrying the secure write on the calling loop', async () => {
  const write = createNotificationDismissalWriter(() => {
    const worker = new Worker(
      `
      require('node:worker_threads').parentPort.on('message', ({id}) => {
        require('node:worker_threads').parentPort.postMessage({id,ok:false,error:'ACL failure'})
      })
    `,
      { eval: true }
    )
    workers.push(worker)
    return worker
  })
  await expect(write('fixture', [])).rejects.toThrow('ACL failure')
})
