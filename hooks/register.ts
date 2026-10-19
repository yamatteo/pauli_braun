import type { EngineInterface, Register } from 'claude-code'

import type { Allow, Mode, Run } from '../types'
import { checkCommit, isOurs, squashMessage, statusPaths } from './commit'
import {
  allowedPath, checkBash, checkEdit, decide, EDIT_TOOLS, inScratch, resolvePath, styleArgMode, THREAD_TOOLS, touchesGitDir,
  type Operation, type PathFacts, type Role, type Target,
} from './rules'

const MODE = { plugin: 'pauli-braun', key: 'mode' } as const
const HANDED_OFF = { plugin: 'pauli-braun', key: 'handedOff' } as const
const RUN = { plugin: 'pauli-braun', key: 'run' } as const

const HANDOFF_TOOL = 'mcp__pauli-braun__handoff'

const STYLE: Record<Role, string> = { pauli: 'pauli-braun:pauli', braun: 'pauli-braun:braun' }
const NAME: Record<Role, string> = { pauli: 'Pauli', braun: 'Braun' }
const STATUS: Record<Role, string> = {
  pauli: 'Pauli · discuss & review, no edits',
  braun: 'Braun · build what git can restore, no git changes',
}
const ADVICE: Record<Role, string> = {
  pauli: 'Pauli reads and runs side-effect-free commands only; propose the change and let the user hand off to Braun.',
  braun: 'Braun changes only what git can restore (tracked files, new files in the project), the scratch folders ' +
    '(/tmp, $TMPDIR) and what the brief allows; version control is the user\'s. Leave it as it is and mention what ' +
    'you would have done in your report. To stage finished work and prepare its commit message, pass "commit" to the ' +
    'hand-off (pauli-braun:report).',
}
const KICKOFF: Record<Role, string> = {
  braun: 'Braun, Pauli has handed off to you: carry out the latest "Brief for Braun" above.',
  pauli: 'Pauli, Braun has handed back to you: review Braun\'s report above against the brief and the actual changes, and give your verdict.',
}

function modeOf(style: string | null | undefined): Mode {
  if (style === STYLE.pauli) return 'pauli'
  if (style === STYLE.braun) return 'braun'
  return 'off'
}

/** The mode the active output style puts the session in. */
async function currentMode($: EngineInterface): Promise<Mode> {
  const { value } = await $.state.get(MODE)
  if (value !== undefined) return value
  const { outputStyle } = await $.settings.read()
  return modeOf(typeof outputStyle === 'string' ? outputStyle : undefined)
}

/** Records the mode and shows it on the status line, when it changed; leaving Braun mode ends the Braun run. */
async function applyMode($: EngineInterface, mode: Mode): Promise<void> {
  const { value } = await $.state.get(MODE)
  if (value !== mode) {
    await $.state.set(MODE, mode)
    $.ui.status(mode === 'off' ? undefined : STATUS[mode])
    if (value === 'braun') await $.state.set(RUN, null)
  }
}

/** The hand-off's `allow`, checked: what the brief allows Braun beyond the defaults. */
function readAllow(allow: unknown): Allow | { problem: string } {
  if (allow === undefined) return { paths: [], commands: [] }
  if (typeof allow !== 'object' || allow === null || Array.isArray(allow)) return { problem: '"allow" must be an object' }
  const list = (v: unknown) =>
    v === undefined ? [] : Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim() !== '') ? (v as string[]) : undefined
  const { paths, commands } = allow as Record<string, unknown>
  const [p, c] = [list(paths), list(commands)]
  if (p === undefined || c === undefined) return { problem: '"allow.paths" and "allow.commands" must be lists of non-empty strings' }
  return { paths: p, commands: c }
}

/** Starts a Braun run: the repository's root and its untracked files now, and what the brief allows. */
async function startRun($: EngineInterface, allow: Allow): Promise<{ problem: string } | undefined> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { problem: 'this folder is not in a git repository, so nothing Braun changes could be restored' }
  const root = top.stdout.trim()
  const untracked = await $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: root })
  if (untracked.exitCode !== 0) return { problem: `git ls-files failed: ${untracked.stderr.trim()}` }
  await $.state.set(RUN, { root, allow, untrackedAtStart: untracked.stdout.split('\0').filter(Boolean) })
  return undefined
}

const NOTHING_KNOWN: PathFacts = {
  scratch: false, allowed: false, inGit: false, outside: false, ignored: false, tracked: false, dirty: false,
  untrackedAtStart: false, directory: false, holdsIgnored: false,
}

/** Why Braun may not write or remove these paths, with what git knows about each; undefined when all may go. */
async function braunRefusal($: EngineInterface, run: Run, targets: readonly Target[], tmpdir: string | undefined): Promise<string | undefined> {
  const kind = async (path: string) => (await $.fs.stat(path).catch(() => undefined))?.kind
  const free = (path: string) => inScratch(path, { tmpdir }) || allowedPath(path, run.allow.paths, run.root)

  // A cp, mv, ln, install or rsync into a directory writes the sources' names inside it.
  const checks: { path: string; op: Operation }[] = []
  for (const target of targets) {
    if (target.sources === undefined || target.sources.length === 0 || (await kind(target.path)) !== 'dir') {
      checks.push(target)
      continue
    }
    for (const source of target.sources) {
      const name = source.replace(/\/+$/, '').slice(source.replace(/\/+$/, '').lastIndexOf('/') + 1)
      if (['', '.', '..'].includes(name) || /[$`*?[]/.test(name)) {
        if (free(target.path)) continue
        return `writing into ${target.path} (what lands there from ${source} cannot be checked)`
      }
      checks.push({ path: `${target.path}/${name}`, op: 'write' })
    }
  }

  // The first rows of the decision need no git.
  const inside: { path: string; op: Operation; rel: string }[] = []
  for (const { path, op } of checks) {
    const facts = { ...NOTHING_KNOWN, scratch: inScratch(path, { tmpdir }), allowed: allowedPath(path, run.allow.paths, run.root),
      inGit: touchesGitDir(path), outside: path !== run.root && !path.startsWith(`${run.root}/`) }
    if (facts.scratch || facts.allowed || facts.inGit || facts.outside) {
      const why = decide(path, op, facts)
      if (why !== undefined) return why
    } else inside.push({ path, op, rel: path === run.root ? '.' : path.slice(run.root.length + 1) })
  }
  if (inside.length === 0) return undefined

  const git = async (args: string[], stdin?: string) => {
    const ran = await $.process.run(['git', ...args], { cwd: run.root, ...(stdin === undefined ? {} : { stdin }) })
    // check-ignore exits 1 when nothing is ignored.
    if (ran.exitCode !== 0 && !(args[0] === 'check-ignore' && ran.exitCode === 1))
      throw new Error(`git ${args[0] === '--literal-pathspecs' ? args[1] : args[0]} failed: ${ran.stderr.trim()}`)
    return ran.stdout
  }
  const split = (out: string) => out.split('\0').filter(Boolean)
  const rels = [...new Set(inside.map(c => c.rel))]
  const removed = [...new Set(inside.filter(c => c.op === 'remove').map(c => c.rel))]
  // check-ignore takes paths, not pathspecs: no --literal-pathspecs, which it refuses.
  const ignored = new Set(split(await git(['check-ignore', '-z', '--stdin'], `${rels.join('\0')}\0`)))
  const tracked = split(await git(['--literal-pathspecs', 'ls-files', '-z', '--', ...rels]))
  const dirty = removed.length === 0 ? [] :
    statusPaths(await git(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...removed]))

  for (const { path, op, rel } of inside) {
    const under = (p: string) => rel === '.' || p === rel || p.startsWith(`${rel}/`)
    const directory = op === 'remove' && (await kind(path)) === 'dir'
    const holdsIgnored = directory &&
      split(await git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', rel])).length > 0
    const why = decide(path, op, {
      ...NOTHING_KNOWN,
      ignored: ignored.has(rel),
      tracked: directory ? tracked.some(under) : tracked.includes(rel),
      dirty: directory ? dirty.some(under) : dirty.includes(rel),
      untrackedAtStart: directory ? run.untrackedAtStart.some(under) : run.untrackedAtStart.includes(rel),
      directory,
      holdsIgnored,
    })
    if (why !== undefined) return why
  }
  return undefined
}

const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']

/**
 * Stages the paths of Braun's `commit` and writes its message to SQUASH_MSG, for VS Code's commit box: a line for the
 * hand-off's result, or why nothing was staged.
 */
async function prepareCommit($: EngineInterface, commit: unknown): Promise<{ done: string } | { problem: string }> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { problem: 'this folder is not in a git repository' }
  const cwd = top.stdout.trim()
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd })

  const names = [...IN_PROGRESS, 'SQUASH_MSG']
  const located = await git('rev-parse', '--path-format=absolute', ...names.flatMap(n => ['--git-path', n]))
  if (located.exitCode !== 0) return { problem: `git rev-parse failed: ${located.stderr.trim()}` }
  const paths = located.stdout.split('\n').map(p => p.trim())
  for (const [k, name] of IN_PROGRESS.entries()) {
    if (await $.fs.exists(paths[k]!)) return { problem: `an operation is in progress in the repository (${name})` }
  }
  const squashMsg = paths[IN_PROGRESS.length]!
  if ((await $.fs.exists(squashMsg)) && !isOurs(await $.fs.read(squashMsg)))
    return { problem: `${squashMsg} exists and was not written by pauli-braun` }

  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
  if (status.exitCode !== 0) return { problem: `git status failed: ${status.stderr.trim()}` }
  const checked = checkCommit(commit, statusPaths(status.stdout))
  if ('problem' in checked) return checked
  const { request } = checked

  // Literal: a path like `docs/[draft].md` or `:x` would otherwise be read as a pathspec pattern.
  const added = await $.process.run(['git', '--literal-pathspecs', 'add', '--', ...request.paths], { cwd })
  if (added.exitCode !== 0) return { problem: `git add failed: ${added.stderr.trim()}` }
  try {
    await $.fs.write(squashMsg, squashMessage(request.message))
  } catch (err) {
    return { problem: `the paths were staged, but writing ${squashMsg} failed: ${String(err)}` }
  }

  const cached = await git('diff', '--cached', '--name-only', '-z')
  const others = cached.stdout.split('\0').filter(p => p !== '' && !request.paths.includes(p))
  return {
    done: `Commit prepared: staged ${request.paths.length} path(s) and wrote the message to ${squashMsg}.` +
      (others.length > 0 ? ` Also staged, not by this hand-off: ${others.join(', ')}.` : ''),
  }
}

/** Switches the output style, then records the mode itself: the plugin's own /output-style hook doesn't see this run. */
async function switchStyle($: EngineInterface, style: string): Promise<void> {
  await $.command.run({ command: 'output-style', args: style })
  const mode = styleArgMode(style)
  if (mode !== undefined) await applyMode($, mode)
}

/** Runs `work` once the session is idle; a command handler or tool call must not await a slash command itself. */
function later($: EngineInterface, label: string, work: () => Promise<void>): void {
  $.clock.after(0, async () => {
    try {
      await work()
    } catch (err) {
      $.ui.toast(`pauli-braun: ${label} failed: ${String(err)}`)
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'handoff',
      description:
        'Hands the session over between the pauli-braun roles. Pauli calls it with to="braun" right after writing ' +
        'the "Brief for Braun", and only when the user asked for the hand-off (the handoff skill). Braun calls it ' +
        'with to="pauli" right after writing its report (the report skill). The output style switches when the ' +
        'current turn ends and the other role starts on its own, so end your turn right after calling it. ' +
        'Braun handing back done work may pass "commit": the plugin stages those paths and writes the message to ' +
        'SQUASH_MSG, where VS Code shows it as the commit message; if that fails, the hand-off is refused with the reason. ' +
        'Pauli handing off may pass "allow": what the brief allows Braun beyond the defaults, for this run only.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: ['pauli', 'braun'] },
          commit: {
            type: 'object',
            description: 'Only Braun, handing back with status done: the commit to prepare for the user.',
            properties: {
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'The changed paths to stage, relative to the repository root as `git status --porcelain` prints them.',
              },
              message: {
                type: 'string',
                description: 'A Conventional Commits message: "<type>[(scope)][!]: <description>" (72 characters at most), then optionally a blank line and a body.',
              },
            },
            required: ['paths', 'message'],
          },
          allow: {
            type: 'object',
            description: 'Only Pauli, handing off to Braun: the brief\'s "Allowed beyond the defaults", enforced for this run only.',
            properties: {
              paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Globs (`*`, `**`, `?`), relative to the repository root or absolute, Braun may write and remove.',
              },
              commands: {
                type: 'array',
                items: { type: 'string' },
                description: 'Command prefixes, matched word by word, Braun may run although they install globally or use sudo.',
              },
            },
          },
        },
        required: ['to'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'pauli', description: 'Switch to Pauli mode: discuss, plan and review, no edits' })
    await $.command.register({ name: 'pb-off', description: 'Leave Pauli/Braun mode (back to the default output style)' })
    await $.command.register({
      name: 'handoff',
      description: 'Pauli writes the Brief for Braun and hands the session to Braun',
      argumentHint: '[notes for the brief]',
    })
    const mode = await currentMode($)
    $.ui.status(mode === 'off' ? undefined : STATUS[mode])
    return next(e)
  })

  // The output style is the mode: read it every time the system prompt is composed.
  on('prompt.compose', async ($, e, next) => {
    await applyMode($, modeOf(e.outputStyle?.name))
    return next(e)
  })

  // And as soon as /output-style runs, so the status line doesn't wait for the next message.
  on('command.run', { command: 'output-style' }, async ($, e, next) => {
    const ran = await next(e)
    const mode = styleArgMode(e.args)
    if (mode !== undefined) await applyMode($, mode)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await $.state.set(HANDED_OFF, false)
    return next(e)
  })

  on('tool.call', { tool: HANDOFF_TOOL }, async ($, e) => {
    const { to, commit, allow } = e as unknown as { to?: unknown; commit?: unknown; allow?: unknown }
    if (to !== 'pauli' && to !== 'braun') return { deny: 'pauli-braun: "to" must be "pauli" or "braun".' }
    if (allow !== undefined && to !== 'braun') return { deny: 'pauli-braun: only a hand-off to Braun takes "allow".' }
    const mode = await currentMode($)
    if (mode === to) return { result: `The session is already in ${NAME[to]} mode; nothing to switch.` }

    let prepared = ''
    if (commit !== undefined) {
      if (mode !== 'braun' || to !== 'pauli') return { deny: 'pauli-braun: only Braun, handing back to Pauli, prepares a commit.' }
      const outcome = await prepareCommit($, commit).catch(err => ({ problem: String(err) }))
      if ('problem' in outcome)
        return {
          deny: `pauli-braun: no commit prepared and no hand-off: ${outcome.problem}. Correct it and call again, or ` +
            'hand off without "commit" and say in one line why no commit was prepared.',
        }
      prepared = ` ${outcome.done}`
    }

    // A hand-off to Braun starts a run: what git can restore is measured now, and the brief's allowances recorded.
    let allowed = ''
    if (to === 'braun') {
      const read = readAllow(allow)
      if ('problem' in read) return { deny: `pauli-braun: no hand-off: ${read.problem}.` }
      const problem = await startRun($, read).catch(err => ({ problem: String(err) }))
      if (problem !== undefined) return { deny: `pauli-braun: no hand-off: ${problem.problem}.` }
      if (read.paths.length + read.commands.length > 0)
        allowed = ` Allowed beyond the defaults for this run: ${[...read.paths, ...read.commands.map(c => `\`${c}\``)].join(', ')}.`
    }

    await $.state.set(HANDED_OFF, true)
    later($, `the hand-off to ${NAME[to]}`, async () => {
      await switchStyle($, STYLE[to])
      await $.prompt.submit({ text: KICKOFF[to] })
    })
    return {
      result: `Hand-off to ${NAME[to]} scheduled: the output style switches to ${STYLE[to]} when this turn ends, ` +
        `and ${NAME[to]} starts on its own.${prepared}${allowed} End your turn now, with no further tool calls.`,
    }
  })

  // Short commands. Each schedules its slash command for when the session is idle, never awaiting it here.
  on('command.run', { command: 'pauli' }, async $ => {
    later($, 'switching to Pauli', () => switchStyle($, STYLE.pauli))
    return { text: 'Switching to Pauli mode.' }
  })

  on('command.run', { command: 'pb-off' }, async $ => {
    later($, 'leaving Pauli/Braun mode', () => switchStyle($, 'default'))
    return { text: 'Leaving Pauli/Braun mode.' }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if ((await currentMode($)) !== 'pauli') return { text: '/handoff only works from Pauli mode (/pauli).' }
    later($, '/pauli-braun:handoff', async () => {
      await $.command.run({ command: 'pauli-braun:handoff', args: e.args })
    })
    return { text: 'Handing off to Braun.' }
  })

  // The guard: what each role may not do.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__')) return next(e)
    const mode = await currentMode($)
    if (mode === 'off') return next(e)

    const refuse = (why: string) => ({
      deny: `pauli-braun (${NAME[mode]} mode): ${why} is blocked. ${ADVICE[mode]}`,
    })
    const input = e as unknown as Record<string, unknown>

    if (THREAD_TOOLS.has(tool)) return refuse(`${tool} (everything stays in this one thread)`)
    const path = String(input.file_path ?? input.notebook_path ?? '')
    const command = String(input.command ?? '')
    if (mode === 'pauli') {
      if (EDIT_TOOLS.has(tool)) {
        const why = checkEdit(tool, path, mode)
        if (why !== undefined) return refuse(why)
      }
      if (tool === 'Bash') {
        const verdict = checkBash(command, mode)
        if (verdict.deny !== undefined) return refuse(verdict.deny)
      }
      return next(e)
    }

    // Braun works only within a run, which /handoff starts; without one, only what Pauli may do.
    const { value: run } = await $.state.get(RUN)
    if (run === undefined || run === null) {
      const why = EDIT_TOOLS.has(tool) ? tool : tool === 'Bash' ? checkBash(command, 'pauli').deny : undefined
      return why === undefined
        ? next(e)
        : { deny: `pauli-braun (Braun mode): ${why} is blocked: there is no Braun run. Start Braun with /handoff.` }
    }
    const ctx = { cwd: await $.session.cwd(), home: await $.env.get('HOME'), tmpdir: await $.env.get('TMPDIR'), allowCommands: run.allow.commands }
    let targets: Target[] = []
    if (EDIT_TOOLS.has(tool)) {
      const why = checkEdit(tool, path, mode)
      if (why !== undefined) return refuse(why)
      targets = [{ path: resolvePath(ctx.cwd, path), op: 'write' }]
    }
    if (tool === 'Bash') {
      const verdict = checkBash(command, mode, ctx)
      if (verdict.deny !== undefined) return refuse(verdict.deny)
      targets = verdict.targets
    }
    if (targets.length > 0) {
      const why = await braunRefusal($, run, targets, ctx.tmpdir).catch(err => `checking what it changes (${String(err)})`)
      if (why !== undefined) return refuse(why)
    }
    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'pauli-braun: its guard failed, so the call was refused.' },
  )

  // Braun always hands back: a turn that ends without the hand-off is sent back once to write the report.
  on('classic.Stop', async ($, e, next) => {
    if (e.stop_hook_active || (await currentMode($)) !== 'braun') return next(e)
    const { value: handedOff } = await $.state.get(HANDED_OFF)
    if (handedOff === true) return next(e)
    const result = await next(e)
    return result.block !== undefined
      ? result
      : {
          ...result,
          block:
            'You are Braun and this turn is ending without a hand-back. Invoke the pauli-braun:report skill now: ' +
            'write your report (done or blocked) and hand the session back to Pauli.',
        }
  })
}
