export function registerMacMouseHistory(
  target: Window,
  navigate: (direction: 'back' | 'forward') => boolean
): () => void {
  if (!target.navigator?.userAgent.includes('Mac')) {
    return () => {}
  }
  // Windows/Linux use Electron's app-command; a second DOM listener would navigate twice.
  const onMouseUp = (event: MouseEvent): void => {
    const direction = event.button === 3 ? 'back' : event.button === 4 ? 'forward' : null
    if (direction && navigate(direction)) {
      event.preventDefault()
    }
  }
  target.addEventListener('mouseup', onMouseUp, true)
  return () => target.removeEventListener('mouseup', onMouseUp, true)
}
