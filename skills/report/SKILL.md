---
name: report
description: Braun's hand-back to Pauli. Use it at the end of every Braun turn in pauli-braun mode, whether the brief is done or blocked - it writes Braun's report and switches the session back to Pauli, who reviews it.
---

# Report and hand back to Pauli

You are Braun, ending your work on the current brief. Write the report in chat, in this form:

**Braun's report**

- **Brief**: its goal, in one line. **Status**: done, partial or blocked.
- **Files changed**: one line each: `path`, what changed.
- **Verification**: how you checked the done-when; the commands you ran and their results, baseline vs. now.
- **Repository state**: the uncommitted changes (`git status --short`, summarized), anything left undone.
- **Commit prepared**: when the status is done, the commit message and the paths you stage with it; files you left
  unstaged and why; otherwise "none" and why.
- **Deviations**: none, or what and why.
- **Blocked on** (only when blocked): what you expected, what happened (with the relevant output), and the decision
  that is needed.
- **Notes for Pauli**: anything that might change the plan.

Then call the `mcp__pauli-braun__handoff` tool with `to: "pauli"`, and end your turn with no further tool calls.
The session switches to Pauli when the turn ends, and Pauli reviews your work.

## Preparing the commit

When the status is **done**, also pass `commit: { paths, message }` to the hand-off. The plugin stages the paths and
writes the message to SQUASH_MSG, so the user finds the commit ready in VS Code and only has to press Commit.

- **paths**: the files this piece of work changed, relative to the repository root as `git status --porcelain`
  prints them; on a follow-up round, every path of the whole piece of work, not only this round's. Leave out files
  that were already dirty in your baseline `git status`, even if you touched them: name them in the report instead.
- **message**: Conventional Commits, `<type>[(scope)][!]: <description>` with type one of `feat`, `fix`, `docs`,
  `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; the subject in the imperative, 72 characters
  at most; then, if useful, a blank line and a short body on what changed and why. No trailers.

If the status is partial or blocked, don't pass `commit`. If the hand-off is refused because of the commit, correct
it and call again, or hand off without `commit` and say in one line why no commit was prepared.
