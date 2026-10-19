import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const AGENT = 'pauli-braun:braun'
const WRITE_NEW = { tool: 'Write', file_path: '/repo/new.txt', content: 'x' } as const

/**
 * The engine beneath the plugin: a repository at /repo with nothing untracked or ignored, slash commands that just
 * run, tool calls that succeed, and `agents` as the session's agent list. Returns what was submitted as prompts, and
 * the toasts shown.
 */
function world(on: On, agents: { id: string; type: string }[] = []) {
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
  on('agent.list', () => ({ value: agents.map(a => ({ ...a, description: '', status: 'running' as const })) }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
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
const BRAUN_CALL = { tool: 'Agent', subagent_type: AGENT, description: 'Braun: add new.txt', prompt: 'Brief for Braun: add new.txt', run_in_background: false } as const

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
  expect(String(opened.result)).toContain('run_in_background: false')

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

  // Once the Agent call has returned, the subagent's run is over, and so is the delegation.
  expect(denied(await $.tool.call({ ...WRITE_NEW, agentId: 'a1' } as never))).toContain('there is no Braun run')
  expect(denied(await $.tool.call(BRAUN_CALL as never))).toContain('/delegate')
})

test('the Agent call for Braun needs an open delegation, the foreground, and runs once', async ($, on) => {
  world(on)
  let runs = 0
  on('tool.call', async (_$, e) => (e.tool === 'Agent' && (runs += 1), { result: 'report' }))
  await command($, 'output-style', 'pauli-braun:pauli')

  expect(denied(await $.tool.call(BRAUN_CALL as never))).toContain('/delegate')

  await command($, 'delegate')
  await $.tool.call(DELEGATE as never)
  const { run_in_background: _, ...inBackground } = BRAUN_CALL
  expect(denied(await $.tool.call(inBackground as never))).toContain('run_in_background: false')
  expect(denied(await $.tool.call({ ...BRAUN_CALL, run_in_background: true } as never))).toContain('run_in_background: false')

  // Two calls at once: the first claims the delegation, the second is refused.
  const [first, second] = await Promise.all([$.tool.call(BRAUN_CALL as never), $.tool.call(BRAUN_CALL as never)])
  expect([denied(first), denied(second)].filter(d => d === undefined)).toHaveLength(1)
  expect(runs).toBe(1)
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
