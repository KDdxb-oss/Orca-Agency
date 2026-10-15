import { describe, expect, it } from 'vitest'
import { buildChatSidebarRows } from './chat-sidebar-rows'
import { chatSession, chatState, chatTab, chatWorktree } from './chat-sidebar-test-fixtures'
import fixture from '../../../../main/runtime/__fixtures__/codex-action-required-titles.json'
import { extractLastOscTitle } from '../../../../shared/agent-detection'

describe('native Codex input waits without hook evidence', () => {
  it.each(fixture.frames)(
    'shows needs-input instead of idle for captured native output',
    (frame) => {
      const leafId = '77777777-7777-4777-8777-777777777777'
      const state = chatState({
        tabsByWorktree: {
          [chatWorktree.id]: [chatTab('a', { title: extractLastOscTitle(frame)! })]
        },
        ptyIdsByTabId: { a: ['retained-pty'] },
        terminalLayoutsByTabId: {
          a: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
        }
      })
      const rows = buildChatSidebarRows(state, [chatSession('session-a')], 200_000)
      expect(rows).toMatchObject([{ tabId: 'a', state: 'waiting', agentType: 'codex' }])
    }
  )
})
