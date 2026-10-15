/** Native Codex OSC title phases while its TUI needs input. Task text is not a signal. */
export function isCodexActionRequiredTitle(title: string): boolean {
  return /^\[ [!.] \] Action Required(?: \| |$)/.test(title)
}
