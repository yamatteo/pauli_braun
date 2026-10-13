# pauli-braun

A Claude Code plugin for a two-role workflow inside **one session thread**:

- **Pauli**, the skeptical architect: discusses, plans and reviews. Reads code and runs tests, but doesn't edit.
- **Braun**, the precision engineer: carries out the agreed brief, verifies it and reports. The only one who
  changes code, and never touches version control.

Each role is an output style, so the active mode is visible in the status line and in the system prompt. Hooks
guard what each role may do, and two skills carry the hand-offs. There is no plan file: the conversation is the
record.

## Install

```
/plugin install pauli-braun --marketplace yamatteo/pauli_braun
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

## The cycle

1. **Discuss** with Pauli (`/pauli`) what to build and how.
2. **`/handoff [notes]`**: Pauli writes a *Brief for Braun* (goal, decisions, steps, what must not change,
   baseline, done-when, when to stop) and the session switches to Braun on its own.
3. **Braun builds**, checks the done-when, writes a *report* and hands back to Pauli automatically, whether the work
   is done or blocked on something unexpected.
4. **Pauli reviews** the report against the brief and the actual diff, and gives a verdict. Back to 1.

Committing is left to you: review the diff and commit when you are satisfied.

## Commands

| Command | What it does |
| --- | --- |
| `/pauli` | Switch to Pauli mode |
| `/braun` | Switch to Braun mode (without a brief; usually you want `/handoff`) |
| `/pb-off` | Leave Pauli/Braun mode (back to the default output style) |
| `/handoff [notes]` | From Pauli mode: write the brief and hand off to Braun |

## Guards

In either mode, subagents and worktrees are refused (`Agent`, `Workflow`, `EnterWorktree`): everything stays in
the one thread.

**Pauli** may read, search, run tests and run read-only git (`status`, `log`, `diff`, `show`, `blame`, `fetch`,
listing branches/tags/stashes, `config --get`…). Refused:

- file edits (`Edit`, `Write`, `NotebookEdit`);
- git commands that change the repository (see Braun) and `git clone`, `git apply` (except `--check`/`--stat`);
- file writers: `rm`, `mv`, `cp`, `mkdir`, `touch`, `ln`, `chmod`, `patch`, `rsync`…, `find -delete`, `find -exec`
  with any of these;
- redirections into files (`>`, `>>`; `/dev/null` and fd duplication are fine), `tee` into a file, `sed -i`,
  `perl -i`;
- package installs and removals (`npm install`, `uv add`, `pip install`, `cargo add`, `apt`…).

**Braun** may edit files, build and install packages. Refused:

- git commands that change the repository: `commit`, `add`, `push`, `pull`, `reset`, `checkout`, `switch`,
  `restore`, `clean`, `rebase`, `merge`, `cherry-pick`, `revert`, `rm`, `mv`, `init`, `gc`…; `stash` (except
  `list`/`show`), creating or deleting branches and tags, writing `config`, changing remotes, worktrees and
  submodules, `apply --index`;
- any write inside `.git`;
- deleting or moving **tracked** files (`rm`, `mv`, `unlink`, `rmdir` are checked against `git ls-files`), and
  `find -delete`, `find -exec rm|mv` and `xargs rm|mv`, whose targets can't be checked.

Commands inside `bash -c`, `eval`, `$(…)`, backticks, `xargs`, `find -exec` and wrappers like `sudo`, `env` or
`timeout` are checked too.

## Known limits

- The shell check is a best-effort parser, not a sandbox: the guards stop mistakes, not a determined agent. The
  roles' own instructions do the rest.
- Output-style text is read when the plugin loads; after editing `output-styles/*.md`, restart Claude Code.
- Braun can't delete or move tracked files at all; such a step ends up in the report for you to do.
- Every Braun turn ends with a report and a hand-back to Pauli: a turn that ends without one is sent back once to
  write it.

## Developing

Install from a local clone, so the plugin is read straight from the folder:

```
claude plugin marketplace add ~/pauli_braun
claude plugin install pauli-braun@pauli-braun
```

Edits apply after `/reload-plugins` (style text after a restart). Check and test with:

```
claude plugin validate .
claude plugin test .
```

## License

MIT
