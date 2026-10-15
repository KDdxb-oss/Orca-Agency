import { expect, it, vi } from 'vitest'
import { chatRow, chatWorktree } from './chat-sidebar-test-fixtures'
import { createSeparateChatWorkspace } from './chat-sidebar-detach'

const mocks = vi.hoisted(() => ({ createFolderWorkspace: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      repos: [],
      projectGroups: [],
      createFolderWorkspace: mocks.createFolderWorkspace
    })
  }
}))

it('uses the current worktree for a saved chat without a folder group', async () => {
  await expect(
    createSeparateChatWorkspace(chatRow(), { useSourceWhenUngrouped: true })
  ).resolves.toEqual(chatWorktree)
  expect(mocks.createFolderWorkspace).not.toHaveBeenCalled()
})

it('keeps separate-workspace drag and detach gated on a folder group', async () => {
  await expect(createSeparateChatWorkspace(chatRow())).rejects.toThrow('This chat needs a folder')
  expect(mocks.createFolderWorkspace).not.toHaveBeenCalled()
})
