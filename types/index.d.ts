export type Mode = 'pauli' | 'braun' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'pauli-braun': {
      /** The mode the active output style puts the session in. */
      mode: Mode
      /** Whether the current turn has already called the handoff tool. */
      handedOff: boolean
    }
  }
}
