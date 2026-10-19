export type Mode = 'pauli' | 'braun' | 'off'

/** What the brief allows Braun beyond the defaults, for one run. */
export type Allow = {
  /** Globs (`*`, `**`, `?`), relative to the project root or absolute, Braun may write and remove. */
  paths: string[]
  /** Command prefixes, word by word, Braun may run although they install globally or use sudo. */
  commands: string[]
}

/** A Braun run, from the hand-off to Braun until the mode stops being Braun. */
export type Run = {
  /** The repository's top level, absolute. */
  root: string
  allow: Allow
  /** The untracked, not ignored, files when the run started, relative to `root`. */
  untrackedAtStart: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'pauli-braun': {
      /** The mode the active output style puts the session in. */
      mode: Mode
      /** Whether the current turn has already called the handoff tool. */
      handedOff: boolean
      /** The current Braun run; null when none. */
      run: Run | null
    }
  }
}
