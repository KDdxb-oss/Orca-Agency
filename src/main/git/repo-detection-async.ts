import { stat } from 'node:fs/promises'
import { gitExecFileAsync } from './runner'
import { scanGitMarkerSync } from './repo-git-marker-scan'
import { normalizeGitRepoRootForInputPath } from './repo-detection'

/** Background probes must never wait for Git on the main-process event loop. */
export async function isGitRepoAsync(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return false
    }
  } catch {
    return false
  }
  let indeterminate = false
  for (const flag of ['--is-inside-work-tree', '--is-bare-repository']) {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', flag], { cwd: path, timeout: 15_000 })
      const answer = stdout.trim()
      if (answer === 'true') {
        return true
      }
      if (answer !== 'false') {
        indeterminate = true
      }
    } catch {
      indeterminate = true
    }
  }
  return indeterminate && scanGitMarkerSync(path).status === 'valid'
}

export async function getGitRepoRootAsync(path: string): Promise<string> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return path
    }
  } catch {
    return path
  }
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
      { cwd: path, timeout: 15_000 }
    )
    const [insideWorkTree, root] = stdout.split('\n').map((line) => line.trim())
    if (insideWorkTree === 'true' && root) {
      return normalizeGitRepoRootForInputPath(path, root)
    }
  } catch {
    // Preserve the existing metadata fallback when Git is temporarily unavailable.
  }
  const marker = scanGitMarkerSync(path)
  return marker.status === 'valid' ? normalizeGitRepoRootForInputPath(path, marker.rootPath) : path
}
