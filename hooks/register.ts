import type { EngineInterface, Register } from 'claude-code'

import type { Mode } from '../types'
import { checkCommit, isOurs, squashMessage, statusPaths } from './commit'
import { checkBash, checkEdit, EDIT_TOOLS, styleArgMode, THREAD_TOOLS, type Role } from './rules'

const MODE = { plugin: 'pauli-braun', key: 'mode' } as const
const HANDED_OFF = { plugin: 'pauli-braun', key: 'handedOff' } as const

const HANDOFF_TOOL = 'mcp__pauli-braun__handoff'

const STYLE: Record<Role, string> = { pauli: 'pauli-braun:pauli', braun: 'pauli-braun:braun' }
const NAME: Record<Role, string> = { pauli: 'Pauli', braun: 'Braun' }
const STATUS: Record<Role, string> = {
  pauli: 'Pauli · discuss & review, no edits',
  braun: 'Braun · build, no git changes',
}
const ADVICE: Record<Role, string> = {
  pauli: 'Pauli reads and runs side-effect-free commands only; propose the change and let the user hand off to Braun.',
  braun: 'Version control is the user\'s: leave it as it is and mention what you would have done in your report. ' +
    'To stage finished work and prepare its commit message, pass "commit" to the hand-off (pauli-braun:report).',
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

/** Records the mode and shows it on the status line, when it changed. */
async function applyMode($: EngineInterface, mode: Mode): Promise<void> {
  const { value } = await $.state.get(MODE)
  if (value !== mode) {
    await $.state.set(MODE, mode)
    $.ui.status(mode === 'off' ? undefined : STATUS[mode])
  }
}

/** The paths among `paths` that git tracks; none outside a repository. */
async function trackedAmong($: EngineInterface, paths: string[]): Promise<string[]> {
  const { exitCode, stdout } = await $.process.run(['git', 'ls-files', '-z', '--', ...paths])
  return exitCode === 0 ? stdout.split('\0').filter(Boolean) : []
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
        'SQUASH_MSG, where VS Code shows it as the commit message; if that fails, the hand-off is refused with the reason.',
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
        },
        required: ['to'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'pauli', description: 'Switch to Pauli mode: discuss, plan and review, no edits' })
    await $.command.register({ name: 'braun', description: 'Switch to Braun mode: build, no git changes' })
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
    const { to, commit } = e as unknown as { to?: unknown; commit?: unknown }
    if (to !== 'pauli' && to !== 'braun') return { deny: 'pauli-braun: "to" must be "pauli" or "braun".' }
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

    await $.state.set(HANDED_OFF, true)
    later($, `the hand-off to ${NAME[to]}`, async () => {
      await switchStyle($, STYLE[to])
      await $.prompt.submit({ text: KICKOFF[to] })
    })
    return {
      result: `Hand-off to ${NAME[to]} scheduled: the output style switches to ${STYLE[to]} when this turn ends, ` +
        `and ${NAME[to]} starts on its own.${prepared} End your turn now, with no further tool calls.`,
    }
  })

  // Short commands. Each schedules its slash command for when the session is idle, never awaiting it here.
  on('command.run', { command: 'pauli' }, async $ => {
    later($, 'switching to Pauli', () => switchStyle($, STYLE.pauli))
    return { text: 'Switching to Pauli mode.' }
  })

  on('command.run', { command: 'braun' }, async $ => {
    later($, 'switching to Braun', () => switchStyle($, STYLE.braun))
    return { text: 'Switching to Braun mode.' }
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
    if (EDIT_TOOLS.has(tool)) {
      const why = checkEdit(tool, String(input.file_path ?? input.notebook_path ?? ''), mode)
      if (why !== undefined) return refuse(why)
    }
    if (tool === 'Bash') {
      const verdict = checkBash(String(input.command ?? ''), mode)
      if (verdict.deny !== undefined) return refuse(verdict.deny)
      if (verdict.mustBeUntracked.length > 0) {
        const tracked = await trackedAmong($, verdict.mustBeUntracked)
        if (tracked.length > 0) return refuse(`deleting or moving tracked files (${tracked.slice(0, 5).join(', ')})`)
      }
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
