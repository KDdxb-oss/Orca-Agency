// Each mounted preview needs its own stream, acknowledgement and grid claim.
let surfaceCounter = 0

export const nextPreviewTerminalSurfaceId = (): string => `preview-surface-${++surfaceCounter}`
