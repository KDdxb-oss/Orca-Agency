export function createPreviewLivePhaseFrame(args: {
  isCurrent: () => boolean
  onLive: () => void
}): { schedule: () => void; dispose: () => void } {
  let frame: number | null = null
  let disposed = false
  return {
    schedule: () => {
      if (disposed || frame !== null) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = null
        if (args.isCurrent()) {
          args.onLive()
        }
      })
    },
    dispose: () => {
      disposed = true
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
    }
  }
}
