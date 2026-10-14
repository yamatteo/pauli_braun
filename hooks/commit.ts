// The commit Braun prepares when handing back done work: the plugin stages the paths Braun names and writes the
// message to SQUASH_MSG, which VS Code shows in its commit box and git deletes once the commit is made.

/** The comment line that marks a SQUASH_MSG as the plugin's own; git and VS Code drop `#` lines from the message. */
export const MARKER = '# pauli-braun: prepared by Braun'

export interface CommitRequest {
  paths: string[]
  message: string
}

const SUBJECT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S/
const SUBJECT_MAX = 72

/** Why `message` is not a Conventional Commits message, or undefined when it is. */
export function messageProblem(message: string): string | undefined {
  const lines = message.trim().split('\n')
  const subject = lines[0] ?? ''
  if (!SUBJECT.test(subject))
    return `the subject "${subject}" is not "<type>[(scope)][!]: <description>" with type one of ` +
      'feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert'
  if (subject.length > SUBJECT_MAX) return `the subject is ${subject.length} characters long (${SUBJECT_MAX} at most)`
  if (lines.length > 1 && lines[1]!.trim() !== '') return 'the body must be separated from the subject by a blank line'
  return undefined
}

/** The paths `git status --porcelain=v1 -z` lists: both sides of a rename or copy. */
export function statusPaths(porcelain: string): string[] {
  const fields = porcelain.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
    if ('RC'.includes(entry[0]!) || 'RC'.includes(entry[1]!)) {
      const from = fields[++i]
      if (from) paths.push(from)
    }
  }
  return paths
}

/** Checks the handoff tool's `commit` against the repository's status: a request, or why it is refused. */
export function checkCommit(commit: unknown, changed: string[]): { request: CommitRequest } | { problem: string } {
  const { paths, message } = (commit ?? {}) as { paths?: unknown; message?: unknown }
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string') || typeof message !== 'string')
    return { problem: '"commit" must be { paths: string[], message: string }' }
  if (paths.length === 0) return { problem: '"commit.paths" is empty' }
  const known = new Set(changed)
  const unknown = paths.filter(p => !known.has(p))
  if (unknown.length > 0)
    return {
      problem: `not changed according to git status (paths are relative to the repository root, as ` +
        `\`git status --porcelain\` prints them): ${unknown.slice(0, 5).join(', ')}`,
    }
  const why = messageProblem(message)
  if (why !== undefined) return { problem: `the commit message: ${why}` }
  return { request: { paths: [...new Set(paths)], message: message.trim() } }
}

/** The SQUASH_MSG content for `message`: the message, then the marker. */
export function squashMessage(message: string): string {
  return `${message.trim()}\n\n${MARKER}\n`
}

/** Whether a SQUASH_MSG is the plugin's own, so it may be overwritten. */
export function isOurs(content: string): boolean {
  return content.split('\n').some(line => line.trimEnd() === MARKER)
}
