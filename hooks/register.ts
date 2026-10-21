import { update, type EngineInterface, type Register } from 'claude-code'

import type { Allow, Armed, Delegation, Mode, Run } from '../types'
import { checkCommit, isOurs, squashMessage, statusPaths } from './commit'
import {
  allowedPath, checkBash, checkEdit, decide, EDIT_TOOLS, inScratch, resolvePath, styleArgMode, THREAD_TOOLS, touchesGitDir,
  type Operation, type PathFacts, type Role, type Target,
} from './rules'

const MODE = { plugin: 'pauli-braun', key: 'mode' } as const
const HANDED_OFF = { plugin: 'pauli-braun', key: 'handedOff' } as const
const RUN = { plugin: 'pauli-braun', key: 'run' } as const
const DELEGATION = { plugin: 'pauli-braun', key: 'delegation' } as const
const ARMED = { plugin: 'pauli-braun', key: 'armed' } as const

const HANDOFF_TOOL = 'mcp__pauli-braun__handoff'
const DELEGATE_TOOL = 'mcp__pauli-braun__delegate'
/** The Braun subagent /delegate starts. */
const AGENT = 'pauli-braun:braun'

const MODELS = ['inherit', 'haiku', 'sonnet', 'opus']
const EFFORTS = ['inherit', 'low', 'medium', 'high', 'xhigh', 'max']

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
const START: Record<Armed['kind'], string> = {
  handoff: 'Only the user starts Braun: ask them to run /handoff.',
  delegate: 'Only the user starts Braun: ask them to run /delegate.',
}
const NO_RUN = 'there is no Braun run. Start Braun with /handoff or /delegate.'
const DELEGATED_END = 'Now end with your report as your final message: Pauli reviews it.'
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

/**
 * Records the mode and shows it on the status line, when it changed. Any change ends the in-thread Braun run: the
 * hand-off records a new one only after its own switch to Braun.
 */
async function applyMode($: EngineInterface, mode: Mode): Promise<void> {
  const { value } = await $.state.get(MODE)
  if (value !== mode) {
    await $.state.set(MODE, mode)
    $.ui.status(mode === 'off' ? undefined : STATUS[mode])
    await $.state.set(RUN, null)
  }
}

/** Unlocks the tool that starts Braun, for the turn the user's command starts; only from Pauli mode. */
async function arm($: EngineInterface, kind: Armed['kind']): Promise<void> {
  if ((await currentMode($)) === 'pauli') await $.state.set(ARMED, { kind, started: false })
}

async function isArmed($: EngineInterface, kind: Armed['kind']): Promise<boolean> {
  const { value } = await $.state.get(ARMED)
  return value?.kind === kind
}

/**
 * The run of a subagent's tool call: the delegated run when the subagent is the delegated Braun, null for a Braun
 * subagent with no delegation, undefined for any other agent. Before the spawn has answered with the id, the agent
 * list tells which agent is a Braun.
 */
async function delegatedRun($: EngineInterface, agentId: string): Promise<Run | null | undefined> {
  const { value } = await $.state.get(DELEGATION)
  if (value !== undefined && value !== null && value.agentId === agentId) return value.run
  const isBraun = (await $.agent.list()).some(a => a.id === agentId && a.type === AGENT)
  if (!isBraun) return undefined
  return value !== undefined && value !== null && value.agentId === null ? value.run : null
}

/** How an agent's loop stands once it has ended. */
const ENDED = new Set(['completed', 'failed', 'killed'])

/**
 * The open delegation, or null. One whose Braun has ended (or is gone) without the end of its turn reaching the
 * plugin is over, and cleared here.
 */
async function liveDelegation($: EngineInterface): Promise<Delegation | null> {
  const { value } = await $.state.get(DELEGATION)
  if (value === undefined || value === null) return null
  if (value.agentId === null) return value
  const agent = (await $.agent.list()).find(a => a.id === value.agentId)
  if (agent !== undefined && !ENDED.has(agent.status)) return value
  await $.state.set(DELEGATION, null)
  return null
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

/** Measures a Braun run: the repository's root and its untracked files now, and what the brief allows. */
async function measureRun($: EngineInterface, allow: Allow): Promise<Run | { problem: string }> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { problem: 'this folder is not in a git repository, so nothing Braun changes could be restored' }
  const root = (await $.fs.stat(top.stdout.trim(), { resolve: true }).catch(() => undefined))?.realPath
  if (root === undefined) return { problem: `the repository's root (${top.stdout.trim()}) cannot be resolved` }
  const untracked = await $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: root })
  if (untracked.exitCode !== 0) return { problem: `git ls-files failed: ${untracked.stderr.trim()}` }
  return { root, allow, untrackedAtStart: untracked.stdout.split('\0').filter(Boolean) }
}

/** The allowances of a run, as a sentence for a tool's result; empty when there are none. */
function allowances(allow: Allow, lead: string): string {
  return allow.paths.length + allow.commands.length === 0 ? ''
    : ` ${lead}: ${[...allow.paths, ...allow.commands.map(c => `\`${c}\``)].join(', ')}.`
}

const NOTHING_KNOWN: PathFacts = {
  scratch: false, allowed: false, inGit: false, outside: false, ignored: false, tracked: false, dirty: false,
  untrackedAtStart: false, directory: false, holdsIgnored: false,
}

/**
 * Where a path lands, symbolic links followed: a write's whole path (a file not there yet is placed by its nearest
 * existing ancestor), a removal's parent folder plus its last name (`rm link` removes the link, not its target).
 * Undefined when nothing resolves.
 */
async function landing($: EngineInterface, path: string, op: Operation): Promise<string | undefined> {
  if (path === '/') return '/'
  const cut = (p: string) => p.lastIndexOf('/')
  let head = path
  const tail: string[] = []
  if (op === 'remove') {
    tail.push(head.slice(cut(head) + 1))
    head = cut(head) <= 0 ? '/' : head.slice(0, cut(head))
  }
  for (;;) {
    const stat = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    // It exists but leads nowhere (a dangling link): what a write would create is unknown.
    if (stat !== undefined) return stat.realPath === undefined ? undefined : [stat.realPath.replace(/\/+$/, ''), ...tail].join('/') || '/'
    if (head === '/') return undefined
    // A link that stat cannot follow is a dangling one, not a file that is not there yet: a write would create its target.
    const parent = cut(head) <= 0 ? '/' : head.slice(0, cut(head))
    const entries = await $.fs.list(parent).catch(() => [])
    if (entries.some(entry => entry.name === head.slice(cut(head) + 1) && entry.isLink)) return undefined
    tail.unshift(head.slice(cut(head) + 1))
    head = cut(head) <= 0 ? '/' : head.slice(0, cut(head))
  }
}

/** Why Braun may not write or remove these paths, with what git knows about each; undefined when all may go. */
async function braunRefusal($: EngineInterface, run: Run, targets: readonly Target[], tmpdir: string | undefined): Promise<string | undefined> {
  const stat = (path: string) => $.fs.stat(path).catch(() => undefined)
  const kind = async (path: string) => (await stat(path))?.kind
  // Scratch is judged where a path lands, against where the scratch folder lands: a link spelled in scratch can lead out.
  const scratch = tmpdir === undefined ? undefined : (await landing($, tmpdir, 'write')) ?? tmpdir
  // Brief globs are written by the user against spellings, and may match the landing too.
  const freeAt = (path: string, real: string | undefined) =>
    (real !== undefined && inScratch(real, { tmpdir: scratch })) ||
    allowedPath(path, run.allow.paths, run.root) || (real !== undefined && allowedPath(real, run.allow.paths, run.root))

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
        if (freeAt(target.path, await landing($, target.path, 'write'))) continue
        return `writing into ${target.path} (what lands there from ${source} cannot be checked)`
      }
      checks.push({ path: `${target.path}/${name}`, op: 'write' })
    }
  }

  // The first rows of the decision need no git. Every path is checked where it lands.
  const inside: { path: string; op: Operation; rel: string; real: string }[] = []
  for (const { path, op } of checks) {
    const real = await landing($, path, op)
    if (real === undefined) return `${op === 'write' ? 'writing' : 'removing'} ${path} (where it lands cannot be determined)`
    if (freeAt(path, real)) continue
    const facts = { ...NOTHING_KNOWN, inGit: touchesGitDir(real), outside: real !== run.root && !real.startsWith(`${run.root}/`) }
    if (facts.inGit || facts.outside) {
      const why = decide(real, op, facts)
      if (why !== undefined) return why
    } else inside.push({ path, op, real, rel: real === run.root ? '.' : real.slice(run.root.length + 1) })
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

  for (const { real, op, rel } of inside) {
    const under = (p: string) => rel === '.' || p === rel || p.startsWith(`${rel}/`)
    // A removed link goes alone, whatever it leads to.
    const own = op === 'remove' ? await stat(real) : undefined
    const directory = own?.kind === 'dir' && !own.isLink
    const holdsIgnored = directory &&
      split(await git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', rel])).length > 0
    const why = decide(real, op, {
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

/** The handoff tool called from a subagent: only the delegated Braun, handing back, and only to prepare its commit. */
async function delegatedHandBack($: EngineInterface, agentId: string, to: Role, commit: unknown) {
  const run = await delegatedRun($, agentId)
  if (run === undefined || run === null)
    return { deny: 'pauli-braun: from a subagent, only the Braun that /delegate started calls the hand-off.' }
  if (to !== 'pauli') return { deny: 'pauli-braun: a delegated Braun hands back to Pauli only.' }
  if (commit === undefined) return { result: `No commit prepared. ${DELEGATED_END}` }
  const outcome = await prepareCommit($, commit).catch(err => ({ problem: String(err) }))
  if ('problem' in outcome)
    return {
      deny: `pauli-braun: no commit prepared: ${outcome.problem}. Correct it and call again, or end without "commit" ` +
        'and say in your report why no commit was prepared.',
    }
  return { result: `${outcome.done} ${DELEGATED_END}` }
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

export const register: Register = (on, options) => {
  const pick = (value: unknown, allowed: string[]) => (typeof value === 'string' && allowed.includes(value) ? value : 'inherit')
  const model = pick(options.braunModel, MODELS)
  const effort = pick(options.braunEffort, EFFORTS)

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
    await $.tool.register({
      name: 'delegate',
      description:
        'Opens a delegation to a Braun subagent. Pauli calls it only when the user ran /delegate (the delegate ' +
        'skill), with the brief\'s allowances if any; then, in the same turn, calls the Agent tool with subagent_type ' +
        `"${AGENT}" and the whole self-contained Brief for Braun as prompt. The Agent call starts Braun in the ` +
        'background; its report arrives later as its hand-back message: review it then, not before.',
      inputSchema: {
        type: 'object',
        properties: {
          allow: {
            type: 'object',
            description: 'The brief\'s "Allowed beyond the defaults", enforced for this delegation only.',
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
      },
      isDeferred: false,
    })
    // Each step on its own, so that one refused can't skip the rest. /handoff and /delegate are the skills' names.
    try {
      await $.command.register({ name: 'pauli', description: 'Switch to Pauli mode: discuss, plan and review, no edits' })
      await $.command.register({ name: 'pb-off', description: 'Leave Pauli/Braun mode (back to the default output style)' })
    } catch (err) {
      $.ui.toast(`pauli-braun: registering /pauli and /pb-off failed: ${String(err)}`)
    }
    try {
      const mode = await currentMode($)
      $.ui.status(mode === 'off' ? undefined : STATUS[mode])
    } catch (err) {
      $.ui.toast(`pauli-braun: showing the mode on the status line failed: ${String(err)}`)
    }
    try {
      await $.agent.register({
        name: 'braun',
        description: 'Braun, started only by the pauli-braun plugin for /delegate.',
        prompt: await $.fs.read(`${$.plugin.root}/prompts/braun.md`),
        model,
        ...(effort === 'inherit' ? {} : { effort }),
      })
    } catch (err) {
      $.ui.toast(`pauli-braun: registering the Braun subagent failed, so /delegate won't work: ${String(err)}`)
    }
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
    await update($, ARMED, armed => (armed !== undefined && armed !== null && !armed.started ? { ...armed, started: true } : armed ?? null))
    return next(e)
  })

  // What a command unlocked lasts for the turn it started; a delegation ends with its subagent's turn, and one that
  // never spawned a subagent ends with Pauli's.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const { value: armed } = await $.state.get(ARMED)
      if (armed?.started === true) await $.state.set(ARMED, null)
      const { value: delegation } = await $.state.get(DELEGATION)
      if (delegation !== undefined && delegation !== null && delegation.agentId === null) await $.state.set(DELEGATION, null)
    } else {
      await update($, DELEGATION, delegation => (delegation?.agentId === e.agentId ? null : delegation ?? null))
    }
    return next(e)
  })

  // The skills /handoff and /delegate unlock their tools, typed by either name; the skill itself then runs.
  on('command.run', { command: ['handoff', 'pauli-braun:handoff'] }, async ($, e, next) => {
    await arm($, 'handoff')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: ['delegate', 'pauli-braun:delegate'] }, async ($, e, next) => {
    await arm($, 'delegate')
    return next(e)
  }).catch(($, e, next) => next(e))

  // The Braun subagent is hidden from the model, and only Pauli's one Agent call for a delegation spawns it.
  on('agent.offer', { agent: AGENT }, async $ => {
    const { value: delegation } = await $.state.get(DELEGATION)
    return { isOffered: delegation !== undefined && delegation !== null && delegation.agentId === null }
  }).catch(() => ({ isOffered: false }))

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== AGENT) return next(e)
    const { value: delegation } = await $.state.get(DELEGATION)
    if (delegation === undefined || delegation === null || !delegation.isClaimed || delegation.agentId !== null)
      return { deny: 'pauli-braun: the Braun subagent is started only by /delegate.' }
    const started = await next(e)
    const { value: now } = await $.state.get(DELEGATION)
    if (started.agentId !== undefined && now !== undefined && now !== null && now.agentId === null)
      await $.state.set(DELEGATION, { ...now, agentId: started.agentId })
    return started
  }).catch(($, e, next) =>
    next.called || e.subagentType !== AGENT ? next(e) : { deny: 'pauli-braun: its guard failed, so the Braun subagent was not started.' },
  )

  on('tool.call', { tool: HANDOFF_TOOL }, async ($, e) => {
    const { to, commit, allow } = e
    if (to !== 'pauli' && to !== 'braun') return { deny: 'pauli-braun: "to" must be "pauli" or "braun".' }
    if (allow !== undefined && to !== 'braun') return { deny: 'pauli-braun: only a hand-off to Braun takes "allow".' }
    if (e.agentId !== undefined) return delegatedHandBack($, e.agentId, to, commit)
    const mode = await currentMode($)
    if (mode === to) return { result: `The session is already in ${NAME[to]} mode; nothing to switch.` }
    if (to === 'braun' && (mode !== 'pauli' || !(await isArmed($, 'handoff')))) return { deny: `pauli-braun: no hand-off. ${START.handoff}` }
    if (to === 'braun' && (await liveDelegation($)) !== null)
      return { deny: 'pauli-braun: no hand-off: a delegated Braun is still working; wait for its report.' }

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

    // A hand-off to Braun measures its run now (what git can restore, the brief's allowances), but records it only
    // once the session has switched to Braun: a switch that never happens leaves no run behind.
    let run: Run | undefined
    if (to === 'braun') {
      const read = readAllow(allow)
      if ('problem' in read) return { deny: `pauli-braun: no hand-off: ${read.problem}.` }
      const measured = await measureRun($, read).catch(err => ({ problem: String(err) }))
      if ('problem' in measured) return { deny: `pauli-braun: no hand-off: ${measured.problem}.` }
      run = measured
      await $.state.set(ARMED, null)
    }
    const allowed = run === undefined ? '' : allowances(run.allow, 'Allowed beyond the defaults for this run')

    await $.state.set(HANDED_OFF, true)
    later($, `the hand-off to ${NAME[to]}`, async () => {
      await switchStyle($, STYLE[to])
      if (run !== undefined) await $.state.set(RUN, run)
      await $.prompt.submit({ text: KICKOFF[to] })
    })
    return {
      result: `Hand-off to ${NAME[to]} scheduled: the output style switches to ${STYLE[to]} when this turn ends, ` +
        `and ${NAME[to]} starts on its own.${prepared}${allowed} End your turn now, with no further tool calls.`,
    }
  }).catch(($, e, next) => ({
    deny: `pauli-braun: the hand-off failed (${next.error?.message ?? 'no reason given'}); ask the user to run /handoff again.`,
  }))

  // /delegate opens a delegation, under a run of its own; Pauli's next call, the Agent tool, runs the subagent.
  on('tool.call', { tool: DELEGATE_TOOL }, async ($, e) => {
    const { allow } = e
    if (e.agentId !== undefined || (await currentMode($)) !== 'pauli')
      return { deny: 'pauli-braun: only Pauli, in the main thread, delegates.' }
    if (!(await isArmed($, 'delegate'))) return { deny: `pauli-braun: no delegation. ${START.delegate}` }
    const read = readAllow(allow)
    if ('problem' in read) return { deny: `pauli-braun: no delegation: ${read.problem}.` }
    if ((await liveDelegation($)) !== null) return { deny: 'pauli-braun: a delegated Braun is already working.' }
    const run = await measureRun($, read).catch(err => ({ problem: String(err) }))
    if ('problem' in run) return { deny: `pauli-braun: no delegation: ${run.problem}.` }

    await $.state.set(ARMED, null)
    await $.state.set(DELEGATION, { run, isClaimed: false, agentId: null })
    return {
      result:
        `Delegation open. Now call the Agent tool with subagent_type "${AGENT}", a short ` +
        'description, and the whole Brief for Braun as prompt. It starts Braun in the background: end your turn, and ' +
        'review Braun\'s report when it arrives as its hand-back message.' +
        allowances(run.allow, 'Allowed beyond the defaults for this delegation'),
    }
  }).catch(($, e, next) => ({
    deny: `pauli-braun: the delegation failed (${next.error?.message ?? 'no reason given'}); ask the user to run /delegate again.`,
  }))

  // Short commands. Each schedules its slash command for when the session is idle, never awaiting it here.
  on('command.run', { command: 'pauli' }, async $ => {
    later($, 'switching to Pauli', () => switchStyle($, STYLE.pauli))
    return { text: 'Switching to Pauli mode.' }
  })

  on('command.run', { command: 'pb-off' }, async $ => {
    later($, 'leaving Pauli/Braun mode', () => switchStyle($, 'default'))
    return { text: 'Leaving Pauli/Braun mode.' }
  })

  // The guard: what each role may not do.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__')) return next(e)
    const input = e as unknown as Record<string, unknown>

    // Pauli's one Agent call for an open delegation. The subagent it spawns keeps the delegation until its turn ends;
    // a call that spawned none ends it when it returns.
    if (tool === 'Agent' && e.agentId === undefined && input.subagent_type === AGENT) {
      const once = `pauli-braun: the Braun subagent runs only once per delegation, which /delegate opens. ${START.delegate}`
      const { value: delegation, version } = await $.state.get(DELEGATION)
      if (delegation === undefined || delegation === null || delegation.isClaimed) return { deny: once }
      // Claimed only at the version read: of two calls at once, the second finds it taken.
      const claimed = await $.state.set(DELEGATION, { ...delegation, isClaimed: true }, { ifVersion: version })
      if (!claimed.isSet) return { deny: once }
      try {
        return await next(e)
      } finally {
        // A get here reads the dispatch's moment, before the spawn: unchanged since the claim, nothing was spawned.
        await $.state.set(DELEGATION, null, { ifVersion: claimed.version })
      }
    }

    // A subagent's call is Braun's when the subagent is a Braun; any other follows the session's mode.
    const delegated = e.agentId === undefined ? undefined : await delegatedRun($, e.agentId)
    const mode = delegated === undefined ? await currentMode($) : 'braun'
    if (mode === 'off') return next(e)

    const refuse = (why: string) => ({
      deny: `pauli-braun (${NAME[mode]} mode): ${why} is blocked. ${ADVICE[mode]}`,
    })

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

    // Braun works only within a run, which /handoff or /delegate starts; without one, only what Pauli may do.
    const run = delegated === undefined ? (await $.state.get(RUN)).value : delegated
    if (run === undefined || run === null) {
      const why = EDIT_TOOLS.has(tool) ? tool : tool === 'Bash' ? checkBash(command, 'pauli').deny : undefined
      return why === undefined ? next(e) : { deny: `pauli-braun (Braun mode): ${why} is blocked: ${NO_RUN}` }
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
