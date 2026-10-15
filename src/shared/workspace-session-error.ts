import type { ZodError } from 'zod'

export function describeWorkspaceSessionError(error: ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}
