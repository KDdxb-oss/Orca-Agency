import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const CHECKPOINT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['checkpoint', 'list'],
    summary: "List a structured agent session's per-turn git checkpoints",
    usage: 'orca checkpoint list --session <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session'],
    notes: [
      'Orca saves one checkpoint per finished turn under refs/orca/checkpoints/<session>/<turn> in the session worktree. Folders outside git have none.'
    ],
    examples: ['orca checkpoint list --session <id>']
  },
  {
    path: ['checkpoint', 'diff'],
    summary: 'Show the files one agent turn changed, with added and removed line counts',
    usage: 'orca checkpoint diff --session <id> [--turn <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'turn'],
    notes: ['Without --turn, shows the latest turn. Lists at most 500 files.'],
    examples: [
      'orca checkpoint diff --session <id>',
      'orca checkpoint diff --session <id> --turn <id>'
    ]
  },
  {
    path: ['checkpoint', 'rollback'],
    destructive: true,
    summary: "Put the session worktree's files back to how one turn found them",
    usage: 'orca checkpoint rollback --session <id> --turn <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'session', 'turn'],
    notes: [
      'Refuses, changing nothing, when files changed after the turn ended or the branch moved since. Only the working tree changes; the index and HEAD are left alone.'
    ],
    examples: ['orca checkpoint rollback --session <id> --turn <id>']
  }
]
