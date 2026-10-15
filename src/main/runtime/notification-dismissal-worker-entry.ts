import { parentPort } from 'node:worker_threads'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type {
  NotificationDismissalWriteRequest,
  NotificationDismissalWriteResponse
} from './notification-dismissal-writer'

if (!parentPort) {
  throw new Error('Notification dismissal writer requires a worker port')
}
const port = parentPort
port.on('message', (request: NotificationDismissalWriteRequest) => {
  let response: NotificationDismissalWriteResponse
  try {
    const ok = writeSecureJsonFile(request.path, request.value)
    response = {
      id: request.id,
      ok,
      ...(ok ? {} : { error: 'Notification dismissal permissions were not verified' })
    }
  } catch {
    response = { id: request.id, ok: false, error: 'Notification dismissal write failed' }
  }
  port.postMessage(response)
})
