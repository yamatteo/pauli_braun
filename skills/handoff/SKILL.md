---
name: handoff
description: Pauli's hand-off to Braun. Writes the Brief for Braun from what was agreed in this conversation, then switches the session to Braun, who starts on it at once.
argument-hint: "[optional: notes on scope or emphasis for the brief]"
disable-model-invocation: true
---

# Hand off to Braun

You are Pauli, handing the agreed work to Braun.

First check that the discussion has really settled it. If a design decision is still open, the scope is unclear,
or there is no way to verify the result, **don't hand off**: say what is missing, and stop.

Otherwise, write the brief in chat, in this form:

**Brief for Braun**

- **Goal**: one or two sentences.
- **Decisions**: what was decided in the discussion and why, in a few lines. Braun reads the whole conversation,
  but this block is authoritative.
- **Steps**: concrete; name the files, functions and tests involved.
- **Must not change**: the files, behaviour or interfaces to leave alone.
- **Baseline**: the test or check commands Braun runs before and after.
- **Done when**: checkable conditions: tests that pass, a command's output, a reproducible behaviour.
- **Allowed beyond the defaults**: "none", or each path glob and command prefix Braun needs past its defaults, with
  why. By default Braun changes only what git can restore (tracked files, new files in the project) and the scratch
  folders (`/tmp`, `$TMPDIR`), installs only into the project, and never uses `sudo`. Name here, explicitly, any
  existing untracked or gitignored file it must change, anything outside the project, a global install
  (`cargo install ripgrep`) or `sudo`.
- **Stop and report if**: the specific surprises to watch for (optional).

Then call the `mcp__pauli-braun__handoff` tool with `to: "braun"` and, when the brief allows anything beyond the
defaults, the same entries as `allow: { paths: [...], commands: [...] }`: paths are globs (`*`, `**`, `?`), relative
to the repository root or absolute; commands are prefixes, matched word by word. The plugin enforces them for this
run only. End your turn with no further tool calls. The session switches to Braun when the turn ends, and Braun
starts on the brief.

User's notes for this hand-off: $ARGUMENTS
