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
- **Deviations**: none, or what and why.
- **Blocked on** (only when blocked): what you expected, what happened (with the relevant output), and the decision
  that is needed.
- **Notes for Pauli**: anything that might change the plan.

Then call the `mcp__pauli-braun__handoff` tool with `to: "pauli"`, and end your turn with no further tool calls.
The session switches to Pauli when the turn ends, and Pauli reviews your work.
