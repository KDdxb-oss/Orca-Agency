import { describe, expect, it } from 'vitest'
import {
  detectAgentStatusFromTitle,
  extractLastOscTitle,
  getAgentLabel,
  normalizeTerminalTitle
} from './agent-detection'
import { resolveExplicitTerminalTitleAgentType } from './terminal-title-agent-type'
import fixture from '../main/runtime/__fixtures__/codex-action-required-titles.json'

describe('native Codex action-required titles', () => {
  it.each(fixture.frames)('recognizes both captured blink phases', (frame) => {
    const title = extractLastOscTitle(frame)!
    expect(detectAgentStatusFromTitle(title)).toBe('permission')
    expect(getAgentLabel(title)).toBe('Codex')
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('codex')
  })

  it('keeps task labels from changing native status or identity', () => {
    const title = '[ ! ] Action Required | \u280b Claude Code working | project'
    expect(detectAgentStatusFromTitle(title)).toBe('permission')
    expect(getAgentLabel(title)).toBe('Codex')
  })

  it('deduplicates captured blink phases without losing the conversation label', () => {
    const titles = fixture.frames.map((frame) => extractLastOscTitle(frame)!)
    expect(titles.map(normalizeTerminalTitle)).toEqual([titles[0], titles[0]])
  })

  it.each(['Action Required', '[ ! ] Action Requiredness', 'project/[ ! ] Action Required'])(
    'does not recognize plain task text: %s',
    (title) => {
      expect(detectAgentStatusFromTitle(title)).toBeNull()
      expect(getAgentLabel(title)).toBeNull()
    }
  )
})
