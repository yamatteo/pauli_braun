export type Mode = 'pauli' | 'braun' | 'off'

/** What the brief allows Braun beyond the defaults, for one run. */
export type Allow = {
  /** Globs (`*`, `**`, `?`), relative to the project root or absolute, Braun may write and remove. */
  paths: string[]
  /** Command prefixes, word by word, Braun may run although they install globally or use sudo. */
  commands: string[]
}

/** A Braun run: in the thread, from the switch to Braun until the mode changes; delegated, for one subagent. */
export type Run = {
  /** The repository's top level, absolute. */
  root: string
  allow: Allow
  /** The untracked, not ignored, files when the run started, relative to `root`. */
  untrackedAtStart: string[]
}

/**
 * A delegated Braun: its run, whether Pauli's one Agent call for it has gone through, and the subagent's id once its
 * spawn has answered.
 */
export type Delegation = {
  run: Run
  isClaimed: boolean
  agentId: string | null
}

/** Which command the user ran to start Braun, and whether its turn has started. */
export type Armed = {
  kind: 'handoff' | 'delegate'
  started: boolean
}

declare module 'claude-code' {
  /** The inputs of the plugin's own tools; the model's values are still untrusted, so the hooks check them. */
  interface McpToolInputs {
    'mcp__pauli-braun__handoff': {
      to: 'pauli' | 'braun'
      commit?: { paths: string[]; message: string }
      allow?: { paths?: string[]; commands?: string[] }
    }
    'mcp__pauli-braun__delegate': {
      allow?: { paths?: string[]; commands?: string[] }
    }
  }

  interface PluginState {
    'pauli-braun': {
      /** The session's mode. */
      mode: Mode
      /** Whether the current turn has already called the handoff tool. */
      handedOff: boolean
      /** The current in-thread Braun run; null when none. */
      run: Run | null
      /** The current delegated Braun; null when none. */
      delegation: Delegation | null
      /** What /handoff or /delegate unlocked; null when nothing. */
      armed: Armed | null
      /** Main-loop turns since the last role row. */
      rowAge: number
      /** Whether Braun has already been sent back, this run, to write its report. */
      nudged: boolean
    }
  }
}
