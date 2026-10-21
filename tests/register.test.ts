import type { AgentStatus, On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const AGENT = 'pauli-braun:braun'
const WRITE_NEW = { tool: 'Write', file_path: '/repo/new.txt', content: 'x' } as const

/**
 * The engine beneath the plugin: a repository at /repo with nothing untracked or ignored, slash commands that just
 * run, tool calls that succeed, and `agents` as the session's agent list (each `running` unless it says otherwise).
 * Returns what was submitted as prompts, and the toasts shown.
 */
function world(
  on: On,
  agents: { id: string; type: string; status?: AgentStatus }[] = [],
  files: Record<string, { kind: 'file' | 'dir'; realPath?: string; isLink?: boolean; dangling?: boolean }> = {},
) {
  const prompts: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u', TMPDIR: '/var/tmp/x' })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('settings.read', () => ({ value: {} }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('command.run', () => ({ text: 'ran' }) as never)
  on('prompt.submit', (_$, e) => (prompts.push(e.text), { text: e.text }) as never)
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: '', status: a.status ?? 'running' })) }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // The file system: /repo, the scratch folders and what `files` lists (each resolving to itself unless it says otherwise,
  // a dangling link not at all); the rest is missing.
  const known: typeof files = { '/repo': { kind: 'dir' }, '/tmp': { kind: 'dir' }, '/var/tmp/x': { kind: 'dir' }, ...files }
  on('fs.list', (_$, e) => ({
    value: Object.entries(known)
      .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === e.path.replace(/\/+$/, ''))
      .map(([path, f]) => ({ name: path.slice(path.lastIndexOf('/') + 1), kind: f.isLink ? 'other' : f.kind, size: 0, mtimeMs: 0, isLink: f.isLink ?? false })),
  }) as never)
  on('fs.stat', (_$, e) => {
    const file = known[e.path]
    if (file === undefined || file.dangling) throw Object.assign(new Error(`ENOENT: ${e.path}`), { code: 'ENOENT' })
    return { value: { kind: file.kind, size: 0, mtimeMs: 0, isLink: file.isLink ?? false, realPath: file.realPath ?? e.path } }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1).filter(a => a !== '--literal-pathspecs')
    if (args[0] === 'rev-parse') return { value: { exitCode: 0, stdout: '/repo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // check-ignore exits 1 when nothing is ignored.
    if (args[0] === 'check-ignore') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { prompts, toasts, clock }
}

/** Runs a slash command the way the user does. */
const command = ($: Engine, name: string, args = '') =>
  $.command.run({ command: name, args } as never)

const denied = (result: { deny?: string }) => result.deny

test('the hand-off to Braun needs /handoff, and only for the turn it starts', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')

  const unasked = await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never)
  expect(denied(unasked)).toContain('/handoff')

  // /delegate unlocks the delegation, not the hand-off.
  await command($, 'delegate')
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toContain('/handoff')

  // The turn /handoff starts may hand off; once it ends without doing so, it no longer can.
  await command($, 'handoff')
  await $.turn.start({ text: 'brief', turnId: 't1' } as never)
  await $.turn.complete({ answer: 'not yet', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toContain('/handoff')

  await command($, 'handoff')
  await $.turn.start({ text: 'brief', turnId: 't2' } as never)
  const asked = await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never)
  expect(denied(asked)).toBeUndefined()
  expect(asked.text ?? JSON.stringify(asked.result)).toContain('Hand-off to Braun scheduled')
})

test('typing the skill by its full name unlocks the hand-off too', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'pauli-braun:handoff')
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toBeUndefined()
})

test('the run is recorded only once the session has switched to Braun', async ($, on) => {
  const { prompts, clock } = world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'handoff')
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toBeUndefined()

  // The switch hasn't happened yet: switching to Braun by hand finds no run.
  await command($, 'output-style', 'pauli-braun:braun')
  expect(denied(await $.tool.call(WRITE_NEW as never))).toContain('there is no Braun run')

  // Back in Pauli mode, the scheduled hand-off switches to Braun, records the run and submits the kickoff.
  await command($, 'output-style', 'pauli-braun:pauli')
  await clock.advance(1)
  expect(prompts.some(p => p.startsWith('Braun, Pauli has handed off to you'))).toBe(true)
  expect(denied(await $.tool.call(WRITE_NEW as never))).toBeUndefined()

  // Any mode change ends the run.
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'output-style', 'pauli-braun:braun')
  expect(denied(await $.tool.call(WRITE_NEW as never))).toContain('there is no Braun run')
})

const DELEGATE = { tool: 'mcp__pauli-braun__delegate' } as const
const BRAUN_CALL = { tool: 'Agent', subagent_type: AGENT, description: 'Braun: add new.txt', prompt: 'Brief for Braun: add new.txt' } as const

/** A subagent's turn, from its start to its end. */
async function subagentTurnEnds($: Engine, agentId: string) {
  await $.turn.start({ text: 'brief', turnId: `${agentId}-t`, agentId } as never)
  await $.turn.complete({ answer: 'report', turnId: `${agentId}-t`, durationMs: 1, isAborted: false, reason: 'answer', agentId } as never)
}

/**
 * Pauli's turn that delegates: /delegate, the delegate tool, and the Agent call, which spawns subagent `a1` in the
 * background and returns at once, as the engine does.
 */
async function delegateInBackground($: Engine, on: On, turnId = 'p1') {
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'Agent') return { result: 'ok' }
    await $.agent.spawn({ prompt: 'Brief for Braun: add new.txt', subagentType: AGENT, background: true } as never)
    return { result: 'Async agent launched successfully.' }
  })
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'delegate')
  await $.turn.start({ text: 'brief', turnId } as never)
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
  expect(denied(await $.tool.call(BRAUN_CALL as never))).toBeUndefined()
  await $.turn.complete({ answer: 'Delegating', turnId, durationMs: 1, isAborted: false, reason: 'answer' } as never)
}

test('delegating needs /delegate and Pauli mode', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  const delegate = () => $.tool.call(DELEGATE as never)

  expect(denied(await delegate())).toContain('/delegate')
  await command($, 'handoff')
  expect(denied(await delegate())).toContain('/delegate')

  await command($, 'delegate')
  expect(denied(await $.tool.call({ ...DELEGATE, allow: { paths: 'x' } } as never))).toContain('no delegation')
  const opened = await delegate()
  expect(denied(opened)).toBeUndefined()
  expect(String(opened.result)).toContain(`subagent_type "${AGENT}"`)

  // /delegate only arms from Pauli mode, and the tool only runs there.
  await command($, 'output-style', 'pauli-braun:braun')
  await command($, 'delegate')
  expect(denied(await delegate())).toContain('only Pauli')
})

test('a delegated Braun works under Braun\'s rules, and its report comes back to Pauli', async ($, on) => {
  world(on, [{ id: 'a1', type: AGENT }])
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  const seen: Record<string, string | undefined> = {}
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'Agent') return { result: 'ok' }
    expect((e as unknown as { prompt: string }).prompt).toBe('Brief for Braun: add new.txt')
    // The engine spawns the subagent: the claimed delegation lets it, and records its id.
    seen.spawn = (await $.agent.spawn({ prompt: 'Brief for Braun: add new.txt', subagentType: AGENT } as never)).deny
    // The subagent at work: a new file is Braun's to write, the repository's git directory is not.
    seen.write = (await $.tool.call({ ...WRITE_NEW, agentId: 'a1' } as never)).deny
    seen.git = (await $.tool.call({ tool: 'Write', file_path: '/repo/.git/HEAD', content: 'x', agentId: 'a1' } as never)).deny
    seen.handBack = (await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun', agentId: 'a1' } as never)).deny
    return { result: "**Braun's report**\n- Status: done" }
  })
  await command($, 'output-style', 'pauli-braun:pauli')

  // Pauli itself still may not write.
  expect(denied(await $.tool.call(WRITE_NEW as never))).toContain('Pauli mode')

  await command($, 'delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
  const ran = await $.tool.call(BRAUN_CALL as never)
  expect(denied(ran)).toBeUndefined()
  expect(String(ran.result)).toContain("**Braun's report**")
  expect(seen.spawn).toBeUndefined()
  expect(seen.write).toBeUndefined()
  expect(seen.git).toContain('.git')
  expect(seen.handBack).toContain('hands back to Pauli only')

  // Once the subagent's turn has ended, its run is over, and so is the delegation.
  await subagentTurnEnds($, 'a1')
  expect(denied(await $.tool.call({ ...WRITE_NEW, agentId: 'a1' } as never))).toContain('there is no Braun run')
  expect(denied(await $.tool.call(BRAUN_CALL as never))).toContain('/delegate')
})

test('the Agent call for Braun needs an open delegation, and runs once', async ($, on) => {
  world(on)
  let runs = 0
  on('tool.call', async (_$, e) => (e.tool === 'Agent' && (runs += 1), { result: 'report' }))
  await command($, 'output-style', 'pauli-braun:pauli')

  expect(denied(await $.tool.call(BRAUN_CALL as never))).toContain('/delegate')

  await command($, 'delegate')
  await $.tool.call(DELEGATE as never)

  // Two calls at once: the first claims the delegation, the second is refused.
  const [first, second] = await Promise.all([$.tool.call(BRAUN_CALL as never), $.tool.call(BRAUN_CALL as never)])
  expect([denied(first), denied(second)].filter(d => d === undefined)).toHaveLength(1)
  expect(runs).toBe(1)
})

test('a background Braun keeps its run after the Agent call and Pauli\'s turn, until its own turn ends', async ($, on) => {
  world(on, [{ id: 'a1', type: AGENT }])
  await delegateInBackground($, on)

  // The Agent call has returned and Pauli's turn is over: the subagent still writes as Braun.
  expect(denied(await $.tool.call({ ...WRITE_NEW, agentId: 'a1' } as never))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/.git/HEAD', content: 'x', agentId: 'a1' } as never))).toContain('.git')

  // Its turn ends: so do its run and the delegation, and a new /delegate may open one.
  await subagentTurnEnds($, 'a1')
  expect(denied(await $.tool.call({ ...WRITE_NEW, agentId: 'a1' } as never))).toContain('there is no Braun run')
  await command($, 'delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
})

test('a delegated Braun that ended without its turn\'s end doesn\'t block the next /delegate', async ($, on) => {
  const agents: { id: string; type: string; status?: AgentStatus }[] = [{ id: 'a1', type: AGENT }]
  world(on, agents)
  await delegateInBackground($, on)

  // While it runs, a second delegation is refused.
  await command($, 'delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toContain('already working')

  // Killed: the delegation is found over, and cleared.
  agents[0]!.status = 'killed'
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
})

test('a /handoff to Braun is refused while a delegated Braun is working', async ($, on) => {
  const agents: { id: string; type: string; status?: AgentStatus }[] = [{ id: 'a1', type: AGENT }]
  world(on, agents)
  await delegateInBackground($, on)

  await command($, 'handoff')
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toContain('still working')

  // Once the subagent is gone from the agent list, the hand-off goes through.
  agents.splice(0)
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toBeUndefined()
})

test('an Agent call that spawns no subagent leaves no delegation behind', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'interrupted' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
  expect(denied(await $.tool.call(BRAUN_CALL as never))).toBeUndefined()

  // Within the same turn, the delegation is already over: a new one may open.
  await command($, 'delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
})

test('a delegation the Agent call never claims ends with Pauli\'s turn', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'delegate')
  await $.turn.start({ text: 'brief', turnId: 't1' } as never)
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
  await $.turn.complete({ answer: 'done', turnId: 't1', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  expect(denied(await $.tool.call(BRAUN_CALL as never))).toContain('/delegate')
})

test('the Braun subagent is hidden from the model, and spawned only by its delegation\'s Agent call', async ($, on) => {
  world(on)
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'x' }))
  const offered = await $.agent.offer({ agent: AGENT, description: '', source: 'plugin', provider: { plugin: 'pauli-braun', tier: 'plugin' } } as never)
  expect(offered.isOffered).toBe(false)
  const spawned = await $.agent.spawn({ prompt: 'go', subagentType: AGENT } as never)
  expect(denied(spawned)).toContain('/delegate')
  // Other agents are left alone.
  expect(denied(await $.agent.spawn({ prompt: 'go', subagentType: 'Explore' } as never))).toBeUndefined()
})

test('the delegated Braun\'s model and effort come from the settings', { options: { braunModel: 'sonnet', braunEffort: 'high' } }, async ($, on) => {
  world(on)
  const specs: Record<string, unknown>[] = []
  on('fs.read', () => ({ value: 'prompt' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', (_$, e) => (specs.push(e as unknown as Record<string, unknown>), { value: { agent: AGENT } }) as never)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  await $.session.start({ cwd: '/repo' } as never)
  expect(specs[0]).toMatchObject({ name: 'braun', model: 'sonnet', effort: 'high', prompt: 'prompt' })
})

test('by default the delegated Braun inherits the session\'s model and effort', async ($, on) => {
  world(on)
  const specs: Record<string, unknown>[] = []
  on('fs.read', () => ({ value: 'prompt' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', (_$, e) => (specs.push(e as unknown as Record<string, unknown>), { value: { agent: AGENT } }) as never)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  await $.session.start({ cwd: '/repo' } as never)
  expect(specs[0]).toMatchObject({ model: 'inherit' })
  expect('effort' in specs[0]!).toBe(false)
})

test('typing /pauli-braun:delegate unlocks the delegation too', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'pauli-braun:delegate')
  expect(denied(await $.tool.call(DELEGATE as never))).toBeUndefined()
})

test('the session starts with /pauli and /pb-off only: /handoff and /delegate are the skills', async ($, on) => {
  world(on)
  const commands: string[] = []
  const agents: string[] = []
  on('fs.read', () => ({ value: 'prompt' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', (_$, e) => (commands.push(e.name), { value: undefined }) as never)
  on('agent.register', (_$, e) => (agents.push(e.name), { value: { agent: AGENT } }) as never)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  await $.session.start({ cwd: '/repo' } as never)
  expect(commands).toEqual(['pauli', 'pb-off'])
  expect(agents).toEqual(['braun'])
})

test('a refused command registration skips nothing else at the start of the session', async ($, on) => {
  const { toasts } = world(on)
  const agents: string[] = []
  on('fs.read', () => ({ value: 'prompt' }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  // No command.register beneath the plugin: every command registration throws, as the engine's refusal does.
  on('agent.register', (_$, e) => (agents.push(e.name), { value: { agent: AGENT } }) as never)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  await $.session.start({ cwd: '/repo' } as never)
  expect(agents).toEqual(['braun'])
  expect(toasts.some(t => t.startsWith('pauli-braun: registering /pauli and /pb-off failed'))).toBe(true)
})

/** A Braun run in the thread, through the hand-off: the session is in Braun mode with a run recorded. */
async function braunRuns($: Engine, on: On, clock: { advance: (ms: number) => Promise<unknown> }) {
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  await command($, 'handoff')
  expect(denied(await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'braun' } as never))).toBeUndefined()
  await clock.advance(1)
}

const LINKS = {
  '/repo/link': { kind: 'dir', realPath: '/elsewhere', isLink: true },
  '/elsewhere': { kind: 'dir' },
  '/repo/scr': { kind: 'dir', realPath: '/tmp/s', isLink: true },
  '/tmp/s': { kind: 'dir' },
} as const

test('Braun\'s writes are checked where they land: through a link out of the project is refused', async ($, on) => {
  const { clock } = world(on, [], LINKS)
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/link/x', content: 'x' } as never))).toContain('outside the project')
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'cp a /repo/link' } as never))).toContain('outside the project')
  // Through a link into scratch, it is free.
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/scr/x', content: 'x' } as never))).toBeUndefined()
})

test('Braun removes a link itself, not what it leads to', async ($, on) => {
  const { clock } = world(on, [], LINKS)
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'rm /repo/link' } as never))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'rm /repo/link/x' } as never))).toContain('outside the project')
})

test('Braun\'s write to a path that lands nowhere is refused, even when it is spelled in scratch', async ($, on) => {
  const { clock } = world(on, [], { '/tmp/dl': { kind: 'file', isLink: true, dangling: true } })
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/nowhere/x/y', content: 'x' } as never))).toContain('cannot be determined')
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/tmp/dl/y', content: 'x' } as never))).toContain('cannot be determined')
  // A scratch path that resolves is free.
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/tmp/nowhere/y', content: 'x' } as never))).toBeUndefined()
})

test('Braun\'s write through a scratch link that leads out is refused', async ($, on) => {
  const { clock } = world(on, [], { '/tmp/l': { kind: 'file', realPath: '/home/u/.bashrc', isLink: true }, '/home/u/.bashrc': { kind: 'file' } })
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/tmp/l', content: 'x' } as never))).toContain('outside the project')
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'echo x > /tmp/l' } as never))).toContain('outside the project')
})

const DANGLING = { '/repo/dl': { kind: 'file', isLink: true, dangling: true } } as const

test('Braun\'s write to a dangling link is refused', async ($, on) => {
  const { clock } = world(on, [], DANGLING)
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/dl', content: 'x' } as never))).toContain('cannot be determined')
})

test('Braun removes a dangling link', async ($, on) => {
  const { clock } = world(on, [], DANGLING)
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'rm /repo/dl' } as never))).toBeUndefined()
})

test('Braun\'s write through an in-project link into scratch is allowed', async ($, on) => {
  const { clock } = world(on, [], LINKS)
  await braunRuns($, on, clock)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/repo/scr/x', content: 'x' } as never))).toBeUndefined()
})

test('a hand-off whose hook fails is refused with the reason', async ($, on) => {
  // The session's agent list comes back broken (null), as the hand-off hook of a subagent reads it.
  world(on, { map: () => null } as never)
  on('tool.call', () => ({ result: 'ok' }))
  await command($, 'output-style', 'pauli-braun:pauli')
  const refused = await $.tool.call({ tool: 'mcp__pauli-braun__handoff', to: 'pauli', agentId: 'a1' } as never)
  expect(denied(refused)).toContain('the hand-off failed')
  expect(denied(refused)).toContain('/handoff')
})
