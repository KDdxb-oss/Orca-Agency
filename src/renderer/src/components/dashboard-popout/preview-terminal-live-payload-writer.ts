import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

type LivePayload = Extract<TerminalPreviewDataPayload, { type: 'data' }>

export function createPreviewLivePayloadWriter(args: {
  ptyId: string
  surfaceId: string
  hasTerminal: () => boolean
  isDisposed: () => boolean
  pending: LivePayload[]
  writeReplayed: (chunk: string, onDone?: () => void, live?: boolean) => void
}): (payload: LivePayload) => void {
  return (payload) => {
    if (!args.hasTerminal()) {
      args.pending.push(payload)
      return
    }
    args.writeReplayed(
      payload.data,
      () => {
        if (!args.isDisposed()) {
          void window.api.terminalPreview.ack(args.ptyId, payload.bytes, args.surfaceId)
        }
      },
      true
    )
  }
}
