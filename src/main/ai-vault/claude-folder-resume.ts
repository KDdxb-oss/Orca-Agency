import path from 'node:path'
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { encodeClaudeProjectPath } from '../../shared/claude-project-path'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'

/** Prepare only a closed chat; the original transcript remains intact if launch fails. */
export async function prepareClaudeFolderResume(
  args: AiVaultPrepareSessionResumeArgs
): Promise<AiVaultPrepareSessionResumeResult> {
  if (
    args.agent !== 'claude' ||
    !args.resumeCwd ||
    !args.sessionId ||
    !/^[a-zA-Z0-9-]+$/.test(args.sessionId)
  ) {
    throw new Error('Invalid Claude folder resume request.')
  }
  const source = await realpath(args.filePath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'The saved Claude conversation file is missing. This chat cannot be resumed from its recorded location.'
      )
    }
    throw error
  })
  const projects = path.dirname(path.dirname(source))
  if (path.basename(projects) !== 'projects') {
    throw new Error('Could not locate the original Claude session. Its files were not changed.')
  }
  // Why: Claude resolves junctions before selecting its project bucket.
  const cwd = await realpath(args.resumeCwd).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        'The selected chat folder no longer exists. Choose an existing folder to reopen this chat.'
      )
    }
    throw error
  })
  if (!(await stat(cwd)).isDirectory()) {
    throw new Error('The selected chat folder is not a directory.')
  }
  const directory = path.join(projects, encodeClaudeProjectPath(cwd))
  const sourceDirectory = path.dirname(source)
  if (
    process.platform === 'win32'
      ? sourceDirectory.toLowerCase() === directory.toLowerCase()
      : sourceDirectory === directory
  ) {
    return { useRealCodexHome: false, relocatedClaudeSession: { cwd, filePath: source } }
  }
  if (path.basename(source) !== `${args.sessionId}.jsonl`) {
    throw new Error(
      'This Claude transcript uses a different file identity; open it in its original folder before moving it.'
    )
  }
  const destination = path.join(directory, `${args.sessionId}.jsonl`)
  if (source !== destination) {
    await mkdir(directory, { recursive: true })
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL)
    } catch (error) {
      // Why: never overwrite a newer continuation already stored at the destination.
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
      const [original, existing] = await Promise.all([readFile(source), readFile(destination)])
      // Why: a Claude continuation may append to the exclusive copy before the saved list rescans.
      const appendedLines = existing
        .subarray(original.length)
        .toString('utf8')
        .trimEnd()
        .split('\n')
      const continued =
        original.length > 0 &&
        original.at(-1) === 10 &&
        existing.length > original.length &&
        existing.subarray(0, original.length).equals(original) &&
        appendedLines.every((line) => {
          try {
            const record: unknown = JSON.parse(line)
            return (
              record !== null &&
              typeof record === 'object' &&
              (!('sessionId' in record) || record.sessionId === args.sessionId)
            )
          } catch {
            return false
          }
        })
      if (!original.equals(existing) && !continued) {
        throw new Error(
          'This folder already contains another saved version of that Claude chat. The originals are unchanged; open that version before moving again.'
        )
      }
    }
    const companions = path.join(path.dirname(source), args.sessionId)
    const companionStat = await stat(companions).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (companionStat?.isDirectory()) {
      await cp(companions, path.join(directory, args.sessionId), { recursive: true, force: false })
    }
  }
  return { useRealCodexHome: false, relocatedClaudeSession: { cwd, filePath: destination } }
}
