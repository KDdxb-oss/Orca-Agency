import { expect, it } from 'vitest'
import { isRegisteredSshFolderStatus, type FolderStatusStore } from './registered-ssh-folder-status'

const store = {
  getRepos: () =>
    [
      { id: 'folder', path: '/work/folder', kind: 'folder' as const, connectionId: 'remote-a' },
      { id: 'git', path: '/work/git', kind: 'git' as const, connectionId: 'remote-a' },
      { id: 'local', path: '/work/local', kind: 'folder' as const },
      {
        id: 'unified',
        path: '/work/unified',
        kind: 'folder' as const,
        executionHostId: 'ssh:remote-a' as const
      },
      {
        id: 'stale',
        path: '/work/stale',
        kind: 'folder' as const,
        executionHostId: 'local' as const,
        connectionId: 'remote-a'
      }
    ].map((repo) => ({ displayName: repo.id, badgeColor: '#000000', addedAt: 0, ...repo })),
  getAllWorktreeMeta: () => ({
    'folder::/work/extra::workspace:11111111-1111-1111-1111-111111111111': {}
  })
} satisfies FolderStatusStore

it('matches only registered folder paths on the requested execution host', () => {
  expect(isRegisteredSshFolderStatus(store, '/work/folder', 'remote-a')).toBe(true)
  expect(isRegisteredSshFolderStatus(store, '/work/folder', 'remote-b')).toBe(false)
  expect(isRegisteredSshFolderStatus(store, '/work/git', 'remote-a')).toBe(false)
  expect(isRegisteredSshFolderStatus(store, '/work/local', 'remote-a')).toBe(false)
  expect(isRegisteredSshFolderStatus(store, '/work/folder/unregistered', 'remote-a')).toBe(false)
  expect(isRegisteredSshFolderStatus(store, '/work/unified', 'remote-a')).toBe(true)
  expect(isRegisteredSshFolderStatus(store, '/work/stale', 'remote-a')).toBe(false)
})

it('recognizes extra folder workspace metadata without querying Git', () => {
  expect(isRegisteredSshFolderStatus(store, '/work/extra', 'remote-a')).toBe(true)
  expect(isRegisteredSshFolderStatus(store, '/work/extra', 'remote-b')).toBe(false)
})
