// Pure rules: what each role may not do. No `$` here, so tests can call it directly.
//
// The shell analysis is best effort: a small lexer that understands quotes,
// separators, redirections, heredocs, `$(...)`, `bash -c`, `xargs` and
// `find -exec`. It is a guard rail against the obvious, not a sandbox.

export type Role = 'pauli' | 'braun'

/** One simple command: its words (quotes removed) and where it redirects output. */
export type SimpleCommand = { words: string[]; redirects: string[] }

/** What a command does to a path: writes (creates, changes) or removes it. */
export type Operation = 'write' | 'remove'

/**
 * A path a Braun command writes or removes, absolute. `sources` are what a cp, mv, ln, install or rsync puts at
 * `path`: when `path` turns out to be a directory, the files that land in it are `path/<basename of each source>`.
 */
export type Target = { path: string; op: Operation; sources?: string[] }

/** What a role's Bash check found: a refusal, and the paths Braun's command writes or removes. */
export type BashVerdict = { deny?: string; targets: Target[] }

/**
 * Where Braun's paths are resolved: the directory relative paths start from, the values `~`, `$HOME` and `$TMPDIR`
 * expand to, and the command prefixes the brief allows beyond the defaults.
 */
export type PathContext = { cwd: string; home?: string; tmpdir?: string; allowCommands?: readonly string[] }

/** Tools no mode may use: everything stays in this one thread. */
export const THREAD_TOOLS = new Set(['Agent', 'Workflow', 'EnterWorktree'])

/** The longest a Braun command may run, in milliseconds: the Bash tool's default timeout. */
export const BRAUN_TIMEOUT_MS = 120_000

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
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' ||
      // Braces group commands only as words of their own: `${HOME}` and `xargs -I{}` keep theirs.
      (c === '{' || c === '}') && !hasWord && /^$|[\s;|&()<>]/.test(src[i + 1] ?? '')) {
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

/**
 * The program and its arguments, past env assignments and wrappers such as `sudo` or `xargs`; `privileged` names the
 * `sudo` or `doas` met on the way.
 */
function unwrap(words: string[]): { argv: string[]; viaXargs: boolean; privileged?: string } {
  let rest = words
  let viaXargs = false
  let privileged: string | undefined
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_]\w*=/.test(rest[0]!)) rest = rest.slice(1)
    const head = basename(rest[0] ?? '')
    if (WRAPPERS.has(head)) {
      if (head === 'sudo' || head === 'doas') privileged ??= head
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
    } else return { argv: rest, viaXargs, privileged }
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

export function touchesGitDir(path: string): boolean {
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

// --- Braun: paths -------------------------------------------------------

/** An absolute path with `.`, `..` and repeated slashes resolved. */
export function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** `path` taken from `base` when relative, normalized. */
export function resolvePath(base: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${base}/${path}`)
}

/** Folders Braun may always write: what is there is nobody's. The session scratchpad lives under them. */
export function inScratch(path: string, ctx: Pick<PathContext, 'tmpdir'>): boolean {
  const roots = ['/tmp', '/private/tmp', ...(ctx.tmpdir ? [normalize(ctx.tmpdir)] : [])]
  return roots.some(root => root !== '/' && (path === root || path.startsWith(`${root}/`)))
}

/** A variable, a substitution or a glob pattern: what the word names is only known when the shell runs it. */
const UNRESOLVED = /[$`*?[]/

/** `~`, `$HOME` and `$TMPDIR` replaced by their values, where known. */
function expand(word: string, ctx: PathContext): string {
  let out = word
  if (ctx.home !== undefined && (out === '~' || out.startsWith('~/'))) out = ctx.home + out.slice(1)
  for (const [name, value] of [['HOME', ctx.home], ['TMPDIR', ctx.tmpdir]] as const) {
    if (value !== undefined) out = out.replace(new RegExp(`\\$(?:${name}\\b|\\{${name}\\})`, 'g'), () => value)
  }
  return out
}

/** Where `word` leads from `base`, when it is literal once expanded. */
function literalPath(word: string, base: string | undefined, ctx: PathContext): string | undefined {
  const expanded = expand(word, ctx)
  if (expanded.startsWith('~') || UNRESOLVED.test(expanded)) return undefined
  if (expanded.startsWith('/')) return normalize(expanded)
  return base === undefined ? undefined : resolvePath(base, expanded)
}

/**
 * Where `word` leads from `base` (undefined after a `cd` the plugin cannot follow), or why it cannot be known. A word
 * with a variable or a pattern is accepted only when its literal folder is already a scratch one: the path is then
 * that folder.
 */
export function resolveWord(word: string, base: string | undefined, ctx: PathContext): { path: string } | { problem: string } {
  const literal = literalPath(word, base, ctx)
  if (literal !== undefined) return { path: literal }
  const expanded = expand(word, ctx)
  const cut = expanded.startsWith('~') ? 0 : expanded.search(UNRESOLVED)
  if (cut < 0) return { problem: `${word} (relative to a directory the plugin cannot follow)` }
  const folder = expanded.slice(0, expanded.lastIndexOf('/', cut) + 1)
  const rest = expanded.slice(folder.length)
  const from = folder.startsWith('/') ? normalize(folder) : base === undefined ? undefined : resolvePath(base, folder || '.')
  if (from !== undefined && inScratch(from, ctx) && !/(^|\/)\.\.(\/|$)/.test(rest)) return { path: from }
  return { problem: `${word} (it holds a variable or a pattern, so the plugin cannot check it)` }
}

/** A glob as a regular expression: `*` and `?` within one path segment, `**` across any depth. */
function globPattern(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else if (i + 2 === glob.length && source.endsWith('/')) {
        // `dir/**` also names `dir` itself.
        source = `${source.slice(0, -1)}(?:/.*)?`
        i += 1
      } else {
        source += '.*'
        i += 1
      }
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Whether `path` (absolute) matches one of the brief's globs, each relative to `root` or absolute. */
export function allowedPath(path: string, globs: readonly string[], root: string): boolean {
  return globs.some(glob => globPattern(glob.startsWith('/') ? glob : `${root}/${glob.replace(/^(\.\/)+/, '')}`).test(path))
}

/**
 * Whether Braun writing or removing `real` (where a path lands, absolute) touches `<root>/.claude`: the folder, what is
 * inside it, or, for a removal, a folder holding it (`rm -r .`). Compared by path segment: `.claude-plugin` is not it.
 */
export function touchesClaudeDir(real: string, op: Operation, root: string): boolean {
  const dir = `${root.replace(/\/+$/, '')}/.claude`
  if (real === dir || real.startsWith(`${dir}/`)) return true
  return op === 'remove' && (real === '/' || dir.startsWith(`${real.replace(/\/+$/, '')}/`))
}

// --- Braun: installs ----------------------------------------------------

const READ_ONLY_PACKAGES = new Set(['list', 'search', 'show', 'info', 'policy', 'madison', 'depends', 'rdepends', 'provides', 'help'])

/** Why this command installs outside the project (globally, for the user or into the system), or undefined. */
export function globalInstall(argv: readonly string[]): string | undefined {
  const program = basename(argv[0] ?? '')
  const args = argv.slice(1)
  const named = args.filter(a => !a.startsWith('-'))
  const [sub, second] = named
  const has = (...flags: string[]) => args.some(a => flags.includes(a))
  const inVenv = /(^|\/)[^/]*venv[^/]*\/bin\//.test(argv[0] ?? '')

  if ((program === 'npm' || program === 'pnpm' || program === 'bun') && (has('-g', '--global', '--location=global')) &&
    (INSTALLERS[program] as readonly string[]).includes(sub ?? ''))
    return `${program} ${sub} --global`
  if (program === 'yarn' && sub === 'global' && !['list', 'bin', 'dir'].includes(second ?? '')) return 'yarn global'
  const pip = /^pip[\d.]*$/.test(program) ? { sub } :
    /^python[\d.]*$/.test(program) && args[args.indexOf('-m') + 1] === 'pip' && args.includes('-m')
      ? { sub: args.slice(args.indexOf('-m') + 2).find(a => !a.startsWith('-')) }
      : undefined
  if (pip !== undefined && (pip.sub === 'install' || pip.sub === 'uninstall')) {
    if (has('--user')) return `pip ${pip.sub} --user`
    if (!inVenv) return `pip ${pip.sub} outside a virtual environment`
  }
  if (program === 'uv') {
    if (sub === 'pip' && has('--system')) return 'uv pip --system'
    if ((sub === 'tool' || sub === 'python') && ['install', 'uninstall', 'upgrade'].includes(second ?? '')) return `uv ${sub} ${second}`
  }
  if (program === 'pipx' && sub !== undefined && !['run', 'list', 'environment'].includes(sub)) return `pipx ${sub}`
  if (program === 'cargo' && (sub === 'install' || sub === 'uninstall')) return `cargo ${sub}`
  if (program === 'go' && sub === 'install') return 'go install'
  if (program === 'gem' && ['install', 'uninstall', 'update'].includes(sub ?? '')) return `gem ${sub}`
  if (['apt', 'apt-get', 'dnf', 'yum'].includes(program) && sub !== undefined && !READ_ONLY_PACKAGES.has(sub)) return `${program} ${sub}`
  if (program === 'pacman' && args.some(a => /^--(sync|remove|upgrade)$/.test(a) || /^-[SRU]/.test(a) && !/^-S[sigl]+$/.test(a)))
    return 'pacman (installing or removing)'
  if (program === 'brew' && ['install', 'uninstall', 'remove', 'rm', 'upgrade', 'reinstall', 'tap', 'untap', 'link', 'unlink'].includes(sub ?? ''))
    return `brew ${sub}`
  if (program === 'snap' && ['install', 'remove', 'refresh', 'revert'].includes(sub ?? '')) return `snap ${sub}`
  if (['conda', 'mamba', 'micromamba'].includes(program) && ['install', 'create', 'remove', 'uninstall', 'update', 'upgrade'].includes(sub ?? ''))
    return `${program} ${sub}`
  return undefined
}

/** Whether a command prefix the brief allows matches `words`, word by word. */
export function allowedCommand(words: readonly string[], prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => {
    const want = prefix.trim().split(/\s+/)
    return want[0] !== '' && want.length <= words.length && want.every((w, k) => words[k] === w)
  })
}

// --- Braun: what a command writes ---------------------------------------

/** Programs that remove the paths they name (mv its sources). */
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mv'])

const RSYNC_VALUED = ['-e', '--rsh', '-f', '--filter', '-T', '--temp-dir', '--exclude', '--include', '--exclude-from', '--include-from',
  '--files-from', '--port', '--log-file', '--partial-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--chmod', '--chown']

/** The operands of a command, and the values of the options that take one (`valued`, or any `--name=value`). */
function operands(args: readonly string[], valued: readonly string[] = []): { list: string[]; value: (...flags: string[]) => string | undefined } {
  const list: string[] = []
  const values = new Map<string, string>()
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') {
      list.push(...args.slice(k + 1))
      break
    }
    if (a.startsWith('--') && a.includes('=')) values.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1))
    else if (a.startsWith('-') && a !== '-') {
      if (valued.includes(a)) values.set(a, args[++k] ?? '')
    } else list.push(a)
  }
  return { list, value: (...flags) => flags.map(f => values.get(f)).find(v => v !== undefined) }
}

/** The files `sed -i` or `perl -i` edits in place (the operands past the script, unless -e gives it); undefined when not in place. */
function inPlaceFiles(args: readonly string[], program: 'sed' | 'perl'): string[] | undefined {
  const script = program === 'sed' ? 'ef' : 'eE'
  const valued = program === 'sed' ? 'efl' : 'eEMmI'
  const digits = program === 'sed' ? '' : 'l0'
  const restOnly = program === 'sed' ? '' : 'xCdD'
  let inPlace = false
  let hasScript = false
  const files: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!
    if (a === '--') {
      files.push(...args.slice(k + 1))
      break
    }
    if (a.startsWith('--')) {
      if (a.startsWith('--in-place')) inPlace = true
      else if (/^--(expression|file)(=|$)/.test(a)) {
        hasScript = true
        if (!a.includes('=')) k++
      } else if (a === '--line-length') k++
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j]!
        if (f === 'i') {
          inPlace = true // the rest is a backup suffix
          break
        }
        if (valued.includes(f)) {
          if (script.includes(f)) hasScript = true
          if (j + 1 === a.length) k++
          break
        }
        if (restOnly.includes(f)) break
        // perl's -0 and -l take digits of their own, attached.
        if (digits.includes(f)) while (/\d/.test(a[j + 1] ?? '')) j++
      }
      continue
    }
    files.push(a)
  }
  if (!inPlace) return undefined
  return hasScript ? files : files.slice(1)
}

type Named = { word: string; op: Operation; sources?: string[] }

/** What one simple command writes or removes, by the words it names them with. */
function namedTargets(argv: readonly string[], redirects: readonly string[]): Named[] {
  const found: Named[] = []
  const write = (words: readonly string[], sources?: string[]) =>
    found.push(...words.map(word => (sources === undefined ? { word, op: 'write' as const } : { word, op: 'write' as const, sources })))
  const remove = (words: readonly string[]) => found.push(...words.map(word => ({ word, op: 'remove' as const })))

  write(redirects.filter(r => !r.startsWith('&') && !SAFE_REDIRECTS.has(r)))
  const program = basename(argv[0] ?? '')
  const args = argv.slice(1)
  switch (program) {
    case 'tee':
      write(operands(args).list.filter(p => !SAFE_REDIRECTS.has(p)))
      break
    case 'sed': case 'perl':
      write(inPlaceFiles(args, program) ?? [])
      break
    case 'cp': case 'mv': case 'ln': case 'install': {
      const { list, value } = operands(args, ['-t', '--target-directory', '-S', '--suffix',
        ...(program === 'install' ? ['-m', '--mode', '-o', '--owner', '-g', '--group'] : [])])
      if (program === 'install' && (args.includes('-d') || args.includes('--directory'))) {
        write(list)
        break
      }
      const folder = value('-t', '--target-directory')
      if (folder !== undefined) {
        if (program === 'mv') remove(list)
        write([folder], list)
      } else if (program === 'ln' && list.length === 1) write([basename(list[0]!)])
      else if (list.length >= 2) {
        if (program === 'mv') remove(list.slice(0, -1))
        write([list.at(-1)!], list.slice(0, -1))
      }
      break
    }
    case 'mkdir':
      write(operands(args, ['-m', '--mode']).list)
      break
    case 'touch':
      write(operands(args, ['-r', '--reference', '-d', '--date', '-t']).list)
      break
    case 'truncate':
      write(operands(args, ['-s', '--size', '-r', '--reference']).list)
      break
    case 'chmod': case 'chown': case 'chgrp': {
      const { list, value } = operands(args)
      // The first operand is the mode or owner, unless --reference gives it (or, for chmod, a mode like `-x` does).
      const given = value('--reference') !== undefined || program === 'chmod' && args.some(a => /^-[rwxXst]+$/.test(a))
      write(given ? list : list.slice(1))
      break
    }
    case 'dd':
      write(args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
      break
    case 'rsync': {
      const { list } = operands(args, RSYNC_VALUED)
      const local = (p: string) => !/^[^/]*:/.test(p)
      if (list.length < 2) break
      const sources = list.slice(0, -1).filter(local)
      if (args.includes('--remove-source-files')) remove(sources)
      if (local(list.at(-1)!)) write([list.at(-1)!], sources)
      break
    }
    case 'rm': case 'rmdir': case 'unlink':
      remove(operands(args).list)
      break
    case 'shred':
      remove(operands(args, ['-n', '--iterations', '-s', '--size', '--random-source']).list)
      break
  }
  return found
}

// --- the Bash check -----------------------------------------------------

function analyse(command: string, role: Role, verdict: BashVerdict, depth: number, ctx: PathContext, start: string | undefined): void {
  // Where relative paths start from: the session's directory, moved by each literal `cd` on this command line.
  let base = start
  for (const { words, redirects } of parse(command)) {
    if (verdict.deny !== undefined) return
    const { argv, viaXargs, privileged } = unwrap(words)
    const program = basename(argv[0] ?? '')
    const args = argv.slice(1)

    // Shells and eval run a string of their own.
    if (depth < 3 && /^(ba|z|da|k)?sh$/.test(program) && args.includes('-c')) {
      analyse(args[args.indexOf('-c') + 1] ?? '', role, verdict, depth + 1, ctx, base)
      continue
    }
    if (depth < 3 && program === 'eval') {
      analyse(args.join(' '), role, verdict, depth + 1, ctx, base)
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
        if (role === 'braun' && REMOVERS.has(innerProgram)) {
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

    // Braun: no sudo and no global installs unless the brief allows them; every path written or removed is collected.
    const permitted = allowedCommand(words, ctx.allowCommands ?? []) || allowedCommand(argv, ctx.allowCommands ?? [])
    if (privileged !== undefined && !permitted) {
      verdict.deny = `${privileged} (allowed only when the brief allows it)`
      return
    }
    const install = globalInstall(argv)
    if (install !== undefined && !permitted) {
      verdict.deny = `${install} (a global or system install, allowed only when the brief allows it)`
      return
    }
    if (program === 'cd' || program === 'pushd') {
      const dir = operands(args).list[0]
      base = dir === '-' ? undefined : literalPath(dir ?? '~', base, ctx)
      continue
    }
    if (program === 'popd') {
      base = undefined
      continue
    }
    if (viaXargs && REMOVERS.has(program)) {
      verdict.deny = `${program} through xargs (its targets cannot be checked against git)`
      return
    }
    for (const { word, op, sources } of namedTargets(argv, redirects)) {
      const resolved = resolveWord(word, base, ctx)
      if ('problem' in resolved) {
        verdict.deny = `${op === 'write' ? 'writing' : 'removing'} ${resolved.problem}`
        return
      }
      verdict.targets.push(sources === undefined ? { path: resolved.path, op } : { path: resolved.path, op, sources })
    }
  }
}

/**
 * Checks a Bash command for a role: a refusal, or (Braun) the absolute paths it writes and removes, for the plugin to
 * check against git. `ctx` resolves Braun's paths.
 */
export function checkBash(command: string, role: Role, ctx: PathContext = { cwd: '/' }): BashVerdict {
  const verdict: BashVerdict = { targets: [] }
  analyse(command, role, verdict, 0, ctx, ctx.cwd)
  return verdict
}

// --- Braun: may this path be written or removed? ------------------------

/**
 * What the plugin knows about a path Braun writes or removes. For a directory being removed, `tracked`, `dirty` and
 * `untrackedAtStart` also hold when they hold for a file inside it; for a write, they are about the path itself.
 */
export type PathFacts = {
  /** Under /tmp, /private/tmp or $TMPDIR. */
  scratch: boolean
  /** Matched by the brief's `allow.paths`. */
  allowed: boolean
  /** Inside a .git folder. */
  inGit: boolean
  /** Outside the project root. */
  outside: boolean
  /** Gitignored (git never reports a tracked file as ignored). */
  ignored: boolean
  tracked: boolean
  /** Has uncommitted changes, staged or not. */
  dirty: boolean
  /** Was untracked when the run started. */
  untrackedAtStart: boolean
  directory: boolean
  /** A directory holding gitignored files. */
  holdsIgnored: boolean
}

/** Why Braun may not write or remove `path`, or undefined: the decision order the user agreed. */
export function decide(path: string, op: Operation, f: PathFacts): string | undefined {
  const verb = op === 'write' ? 'writing' : 'removing'
  if (f.scratch || f.allowed) return undefined
  if (f.inGit) return `${verb} ${path} (inside .git)`
  if (f.outside) return `${verb} ${path} (outside the project)`
  if (f.ignored) return `${verb} ${path} (gitignored, so git cannot restore it)`
  if (f.tracked) {
    if (op === 'write') return undefined
    if (f.dirty) return `removing ${path} (it has uncommitted changes git cannot restore)`
    if (f.directory && (f.holdsIgnored || f.untrackedAtStart)) return `removing ${path} (it holds untracked or ignored files git cannot restore)`
    return undefined
  }
  if (f.untrackedAtStart) return `${verb} ${path} (untracked since before this run, so git cannot restore it)`
  if (op === 'remove' && f.directory && f.holdsIgnored) return `removing ${path} (it holds gitignored files git cannot restore)`
  return undefined
}

/** Checks a file-writing tool call for a role. */
export function checkEdit(tool: string, path: string, role: Role): string | undefined {
  if (role === 'pauli') return `${tool} (Pauli does not edit files)`
  return touchesGitDir(path) ? `${tool} on ${path} (inside .git)` : undefined
}
