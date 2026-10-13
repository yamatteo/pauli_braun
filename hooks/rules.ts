// Pure rules: what each role may not do. No `$` here, so tests can call it directly.
//
// The shell analysis is best effort: a small lexer that understands quotes,
// separators, redirections, heredocs, `$(...)`, `bash -c`, `xargs` and
// `find -exec`. It is a guard rail against the obvious, not a sandbox.

export type Role = 'pauli' | 'braun'

/** One simple command: its words (quotes removed) and where it redirects output. */
export type SimpleCommand = { words: string[]; redirects: string[] }

/** What a role's Bash check found: a refusal, and paths whose tracked status must be checked. */
export type BashVerdict = { deny?: string; mustBeUntracked: string[] }

/** Tools no mode may use: everything stays in this one thread. */
export const THREAD_TOOLS = new Set(['Agent', 'Workflow', 'EnterWorktree'])

/** Tools that write files. */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

const SAFE_REDIRECTS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

// --- lexing --------------------------------------------------------------

/** Drops heredoc bodies, keeping the line that opens them. */
function stripHeredocs(src: string): string {
  return src.replace(/<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<HEREDOC$3')
}

/** The bodies of `$(...)` and backticks, which run as commands of their own. */
function substitutions(src: string): string[] {
  const found: string[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        if (src[j] === '(') depth++
        else if (src[j] === ')') depth--
        j++
      }
      found.push(src.slice(i + 2, j - 1))
      i = j - 1
    } else if (src[i] === '`') {
      const j = src.indexOf('`', i + 1)
      if (j < 0) break
      found.push(src.slice(i + 1, j))
      i = j
    }
  }
  return found
}

/** Splits a command line into simple commands. */
export function parse(source: string): SimpleCommand[] {
  const src = stripHeredocs(source)
  const commands: SimpleCommand[] = []
  let words: string[] = []
  let redirects: string[] = []
  let word = ''
  let hasWord = false
  let target: 'word' | 'redirect' | 'skip' = 'word'

  const endWord = () => {
    if (!hasWord) return
    if (target === 'redirect') redirects.push(word)
    else if (target === 'word') words.push(word)
    target = 'word'
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects })
    words = []
    redirects = []
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? src.length : j
      word += src.slice(i + 1, end)
      hasWord = true
      i = end
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      word += src.slice(i + 1, j).replace(/\\(.)/g, '$1')
      hasWord = true
      i = j
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') word += src[i + 1] ?? ''
      hasWord = src[i + 1] !== '\n' || hasWord
      i++
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else if (c === '&' && src[i + 1] === '>') {
      endWord()
      i += src[i + 2] === '>' ? 2 : 1
      target = 'redirect'
    } else if (c === '>') {
      // A file descriptor written just before (`2>`) belongs to the redirection.
      if (hasWord && /^\d+$/.test(word)) {
        word = ''
        hasWord = false
      } else endWord()
      if (src[i + 1] === '>' || src[i + 1] === '|') i++
      target = 'redirect'
      if (src[i + 1] === '&') {
        // `>&2`: a duplication, not a file.
        word = '&'
        hasWord = true
        i++
      }
    } else if (c === '<') {
      endWord()
      while (src[i + 1] === '<') i++
      target = 'skip'
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      endCommand()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()

  for (const inner of substitutions(src)) commands.push(...parse(inner))
  return commands
}

// --- command shapes ------------------------------------------------------

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'env', 'timeout', 'watch'])

/** The program and its arguments, past env assignments and wrappers such as `sudo` or `xargs`. */
function unwrap(words: string[]): { argv: string[]; viaXargs: boolean } {
  let rest = words
  let viaXargs = false
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_]\w*=/.test(rest[0]!)) rest = rest.slice(1)
    const head = basename(rest[0] ?? '')
    if (WRAPPERS.has(head)) {
      rest = rest.slice(1)
      while (rest.length > 0 && rest[0]!.startsWith('-')) rest = rest.slice(1)
      if (head === 'timeout' && rest.length > 0) rest = rest.slice(1)
    } else if (head === 'xargs') {
      viaXargs = true
      rest = rest.slice(1)
      while (rest.length > 0 && rest[0]!.startsWith('-')) {
        const flag = rest[0]!
        rest = rest.slice(/^-[IdEnLPs]$|^--(?:replace|delimiter|max-args|max-procs)$/.test(flag) ? 2 : 1)
      }
    } else return { argv: rest, viaXargs }
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function positionals(args: string[]): string[] {
  const dash = args.indexOf('--')
  const before = dash < 0 ? args : args.slice(0, dash)
  const after = dash < 0 ? [] : args.slice(dash + 1)
  return [...before.filter(a => !a.startsWith('-')), ...after]
}

function touchesGitDir(path: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(path)
}

// --- git -----------------------------------------------------------------

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** Why this git invocation changes the repository, or undefined when it only reads. */
export function gitChange(args: string[], role: Role): string | undefined {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += GIT_GLOBAL_WITH_VALUE.has(args[i]!) ? 2 : 1
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === undefined) return undefined
  const first = rest[0]
  const has = (...flags: string[]) => rest.some(r => flags.includes(r) || flags.some(f => f.startsWith('--') && r.startsWith(`${f}=`)))

  switch (sub) {
    case 'commit': case 'push': case 'pull': case 'reset': case 'checkout': case 'switch':
    case 'restore': case 'clean': case 'rebase': case 'merge': case 'cherry-pick': case 'revert':
    case 'am': case 'add': case 'rm': case 'mv': case 'update-ref': case 'update-index':
    case 'read-tree': case 'checkout-index': case 'commit-tree': case 'gc': case 'prune':
    case 'repack': case 'filter-branch': case 'filter-repo': case 'replace': case 'init':
    case 'mergetool': case 'sparse-checkout': case 'lfs':
      return `git ${sub}`
    case 'clone':
      return role === 'pauli' ? 'git clone' : undefined
    case 'stash':
      return first === undefined || !['list', 'show'].includes(first) ? 'git stash' : undefined
    case 'tag':
      return rest.length === 0 || has('-l', '--list', '--contains', '--points-at', '--merged', '--no-merged') && !has('-d', '--delete', '-f', '--force')
        ? undefined
        : 'git tag'
    case 'branch': {
      if (rest.some(r => /^-[a-zA-Z]*[dDmMcCfu]/.test(r) || /^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track)\b/.test(r)))
        return 'git branch (changing branches)'
      const valued = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color', '--abbrev'])
      const named = rest.filter((r, k) => !r.startsWith('-') && !valued.has(rest[k - 1] ?? ''))
      return named.length === 0 || has('-l', '--list') ? undefined : 'git branch (creating a branch)'
    }
    case 'config':
      return has('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section') ||
        (first !== undefined && ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(first)) ||
        (!has('--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list') && positionals(rest).length >= 2)
        ? 'git config (writing)'
        : undefined
    case 'remote':
      return first === undefined || ['-v', '--verbose', 'show', 'get-url'].includes(first) ? undefined : `git remote ${first}`
    case 'worktree':
      return first === 'list' ? undefined : 'git worktree'
    case 'submodule':
      return first === undefined || ['status', 'summary'].includes(first) ? undefined : `git submodule ${first}`
    case 'reflog':
      return first === 'expire' || first === 'delete' ? `git reflog ${first}` : undefined
    case 'notes':
      return first === undefined || ['list', 'show'].includes(first) ? undefined : 'git notes'
    case 'bisect':
      return first === undefined || ['log', 'view', 'visualize'].includes(first) ? undefined : 'git bisect'
    case 'symbolic-ref':
      return has('-d', '--delete') || positionals(rest).length >= 2 ? 'git symbolic-ref (writing)' : undefined
    case 'apply':
      if (has('--index', '--cached', '-3', '--3way')) return 'git apply (to the index)'
      return role === 'pauli' && !has('--check', '--stat', '--numstat', '--summary') ? 'git apply' : undefined
    default:
      return undefined
  }
}

// --- the roles -----------------------------------------------------------

const FILE_WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'dd', 'shred', 'install', 'rsync', 'patch'])

const INSTALLERS: Record<string, readonly string[] | 'any'> = {
  npm: ['install', 'i', 'add', 'ci', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade', 'link', 'unlink', 'prune', 'dedupe', 'publish'],
  pnpm: ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'link', 'unlink', 'prune', 'dedupe', 'publish'],
  yarn: ['install', 'add', 'remove', 'upgrade', 'up', 'link', 'unlink', 'publish'],
  bun: ['install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'link', 'unlink', 'publish'],
  pip: ['install', 'uninstall', 'download'],
  pip3: ['install', 'uninstall', 'download'],
  uv: ['add', 'remove', 'sync', 'lock', 'venv', 'init', 'publish'],
  cargo: ['add', 'remove', 'rm', 'install', 'uninstall', 'update', 'publish'],
  go: ['get', 'install'],
  gem: ['install', 'uninstall', 'update'],
  apt: 'any', 'apt-get': 'any', dnf: 'any', yum: 'any', pacman: 'any', brew: ['install', 'uninstall', 'upgrade', 'remove'],
  snap: ['install', 'remove', 'refresh'], conda: ['install', 'remove', 'update', 'create'], mamba: ['install', 'remove', 'update', 'create'],
}

/** Why Pauli may not run this command (a side effect), or undefined. */
function pauliChange(argv: string[], redirects: string[]): string | undefined {
  const written = redirects.find(r => !r.startsWith('&') && !SAFE_REDIRECTS.has(r))
  if (written !== undefined) return `writing to ${written} with a redirection`
  const program = basename(argv[0] ?? '')
  const args = argv.slice(1)
  if (FILE_WRITERS.has(program)) return program
  if (program === 'tee' && positionals(args).some(p => !SAFE_REDIRECTS.has(p))) return 'tee into a file'
  if (program === 'sed' && args.some(a => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) return 'sed -i'
  if (program === 'perl' && args.some(a => /^-[^-]*i/.test(a))) return 'perl -i'
  if (program === 'yarn' && args.length === 0) return 'yarn (install)'
  if (/^python[\d.]*$/.test(program) && args[0] === '-m' && (args[1] === 'pip' || args[1] === 'venv')) return `python -m ${args[1]}`
  if (program === 'uv' && (args[0] === 'pip' || args[0] === 'tool' || args[0] === 'python') && ['install', 'uninstall'].includes(args[1] ?? '')) return `uv ${args[0]} ${args[1]}`
  const installer = INSTALLERS[program]
  if (installer === 'any' && args.length > 0) return `${program} ${args[0]}`
  if (Array.isArray(installer) && installer.includes(args[0] ?? '')) return `${program} ${args[0]}`
  return undefined
}

function analyse(command: string, role: Role, verdict: BashVerdict, depth: number): void {
  for (const { words, redirects } of parse(command)) {
    if (verdict.deny !== undefined) return
    const { argv, viaXargs } = unwrap(words)
    const program = basename(argv[0] ?? '')
    const args = argv.slice(1)

    // Shells and eval run a string of their own.
    if (depth < 3 && /^(ba|z|da|k)?sh$/.test(program) && args.includes('-c')) {
      analyse(args[args.indexOf('-c') + 1] ?? '', role, verdict, depth + 1)
      continue
    }
    if (depth < 3 && program === 'eval') {
      analyse(args.join(' '), role, verdict, depth + 1)
      continue
    }
    // find's -exec runs a command of its own; -delete deletes.
    if (program === 'find') {
      if (args.includes('-delete')) {
        verdict.deny = role === 'pauli' ? 'find -delete' : 'find -delete (its targets cannot be checked against git)'
        return
      }
      const exec = args.findIndex(a => ['-exec', '-execdir', '-ok', '-okdir'].includes(a))
      if (exec >= 0) {
        const end = args.findIndex((a, k) => k > exec && (a === ';' || a === '+'))
        const inner = unwrap(args.slice(exec + 1, end < 0 ? undefined : end)).argv
        const innerProgram = basename(inner[0] ?? '')
        if (role === 'braun' && (innerProgram === 'rm' || innerProgram === 'mv')) {
          verdict.deny = `find -exec ${innerProgram} (its targets cannot be checked against git)`
          return
        }
        if (role === 'pauli') {
          const why = pauliChange(inner, [])
          if (why !== undefined) {
            verdict.deny = `find -exec ${why}`
            return
          }
        }
      }
    }

    if (program === 'git') {
      const why = gitChange(args, role)
      if (why !== undefined) {
        verdict.deny = why
        return
      }
    }

    if (role === 'pauli') {
      const why = pauliChange(argv, redirects)
      if (why !== undefined) {
        verdict.deny = why
        return
      }
      continue
    }

    // Braun: may write the working tree, but not .git, and may not delete or move tracked files.
    const intoGit = redirects.find(touchesGitDir)
    if (intoGit !== undefined) {
      verdict.deny = `writing into ${intoGit}`
      return
    }
    if (program === 'rm' || program === 'mv' || program === 'unlink' || program === 'rmdir') {
      let paths = positionals(args)
      if (program === 'mv') {
        const t = args.findIndex(a => a === '-t' || a.startsWith('--target-directory'))
        paths = t >= 0 ? paths.filter(p => p !== args[t + 1]) : paths.slice(0, -1)
      }
      if (viaXargs) {
        verdict.deny = `${program} through xargs (its targets cannot be checked against git)`
        return
      }
      const gitPath = paths.find(touchesGitDir)
      if (gitPath !== undefined) {
        verdict.deny = `${program} ${gitPath}`
        return
      }
      verdict.mustBeUntracked.push(...paths)
    }
  }
}

/** Checks a Bash command for a role: a refusal, or paths that must turn out untracked. */
export function checkBash(command: string, role: Role): BashVerdict {
  const verdict: BashVerdict = { mustBeUntracked: [] }
  analyse(command, role, verdict, 0)
  return verdict
}

/** Checks a file-writing tool call for a role. */
export function checkEdit(tool: string, path: string, role: Role): string | undefined {
  if (role === 'pauli') return `${tool} (Pauli does not edit files)`
  return touchesGitDir(path) ? `${tool} on ${path} (inside .git)` : undefined
}

/** The mode `/output-style <args>` switches to; undefined when it switches nothing (a bare `/output-style` lists). */
export function styleArgMode(args: string): Role | 'off' | undefined {
  const style = args.trim().toLowerCase()
  if (style === '') return undefined
  if (style === 'pauli-braun:pauli') return 'pauli'
  if (style === 'pauli-braun:braun') return 'braun'
  return 'off'
}
