# pauli-braun

A Claude Code plugin for a two-role workflow inside **one session thread**:

- **Pauli**, the skeptical architect: discusses, plans and reviews. Reads code and runs tests, but doesn't edit.
- **Braun**, the precision engineer: carries out the agreed brief, verifies it and reports. The only one who
  changes code. It never touches version control itself: when its work is done, the plugin stages it and prepares
  the commit message for you.

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
   baseline, done-when, what Braun may do beyond its defaults, when to stop) and the session switches to Braun on
   its own. This is the only way to start Braun, and it needs a git repository: Braun's defaults are what git can
   restore.
3. **Braun builds**, checks the done-when, writes a *report* and hands back to Pauli automatically, whether the work
   is done or blocked on something unexpected.
4. **Pauli reviews** the report against the brief and the actual diff, and gives a verdict. Back to 1.

Committing is left to you, but prepared. When Braun hands back done work, it names the files it changed and writes
a [Conventional Commits](https://www.conventionalcommits.org) message; the plugin stages those files and writes the
message to `.git/SQUASH_MSG`. VS Code's Source Control box shows that message, so once Pauli's review and yours are
done you only press Commit (`git commit` in a terminal starts from it too). Git deletes the file after the commit.
The plugin prepares nothing, and refuses the hand-off until Braun corrects it, when a merge, rebase, cherry-pick or
revert is in progress, when a `SQUASH_MSG` it didn't write is there, when a path isn't among git's changes, or when
the message isn't a Conventional Commits one. Files that were already dirty before Braun started are left unstaged.

## Commands

| Command | What it does |
| --- | --- |
| `/pauli` | Switch to Pauli mode |
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

**Braun** works within a *run*, which `/handoff` starts: the plugin notes the repository's root and its untracked
files at that moment, and the brief's **Allowed beyond the defaults** (passed to the hand-off as `allow`). The run
ends when the session leaves Braun mode. Switching to Braun's style by hand starts no run, and every write is then
refused ("start Braun with /handoff").

Within a run, Braun may change what can be recovered. The plugin checks each path a command writes or removes
(file edits; redirections, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `install`, `ln`, `mkdir`, `touch`, `chmod`,
`chown`, `truncate`, `dd of=`, `rsync`, `rm`, `rmdir`, `unlink`, `shred`), in this order:

1. under `/tmp`, `/private/tmp` or `$TMPDIR` (the session scratchpad lives there): allowed;
2. matched by a glob the brief allows: allowed;
3. inside `.git`: refused;
4. outside the project: refused;
5. gitignored: refused;
6. tracked: writing is allowed, even over your uncommitted changes (Braun leaves such files out of its commit);
   removing or moving it is allowed only when it has no uncommitted changes (for a folder: no dirty tracked file,
   and nothing ignored or untracked-before-the-run inside);
7. untracked and already there when the run started (`.env`, notes): refused;
8. new, or created during the run: allowed (a folder holding gitignored files can't be removed).

Installs into the project are allowed (`npm`/`pnpm`/`yarn`/`bun` without `-g`, `uv add`/`sync`, `uv pip`,
`poetry add`, a venv's `pip`). Refused unless the brief allows the command's prefix:

- global installs: `npm -g`, `yarn global`;
- `pip` outside a venv or with `--user`, `pipx`, `uv tool install`, `uv python install`, `uv pip --system`;
- `cargo install`, `go install`, `gem install`;
- system package managers: `apt`, `dnf`, `yum`, `pacman`, `brew`, `snap`, `conda`/`mamba`;
- any `sudo` or `doas`.

Also refused, whatever the brief says:

- git commands that change the repository: `commit`, `add`, `push`, `pull`, `reset`, `checkout`, `switch`,
  `restore`, `clean`, `rebase`, `merge`, `cherry-pick`, `revert`, `rm`, `mv`, `init`, `gc`…;
- `stash` (except `list`/`show`), creating or deleting branches and tags, writing `config`, changing remotes,
  worktrees and submodules, `apply --index`;
- `find -delete`, and `find -exec` or `xargs` with `rm`, `mv`, `rmdir`, `unlink` or `shred`, whose targets can't be
  checked.

Commands inside `bash -c`, `eval`, `$(…)`, backticks, `xargs`, `find -exec` and wrappers like `sudo`, `env` or
`timeout` are checked too.

## Known limits

- The shell check is a best-effort parser, not a sandbox: the guards stop mistakes, not a determined agent. The
  roles' own instructions do the rest.
- Output-style text is read when the plugin loads; after editing `output-styles/*.md`, restart Claude Code.
- Braun's paths:
  - **Relative paths** resolve from the session's directory. A literal `cd DIR` earlier on the same command line
    moves the base; a `cd` inside `( … )` still counts after the parentheses. A path after a `cd` the plugin
    can't follow (`cd "$X"`, `cd -`) is refused.
  - **Variables and patterns:** a path holding a variable, a substitution or a glob (`$OUT`, `*.log`) is refused,
    unless its literal folder is already a scratch one. Only `~`, `$HOME` and `$TMPDIR` are expanded.
  - **Symlinks aren't resolved:** a link inside the project that points outside counts as inside.
  - **Unchecked targets:** `patch` and `git apply` (to the working tree) are allowed, with their targets unchecked.
    So are `xargs` and `find -exec` with writers other than removals. Files copied into a folder are checked by
    name, but the contents of a tree (`cp -r`, `rsync dir/`) aren't checked file by file.
- Every Braun turn ends with a report and a hand-back to Pauli: a turn that ends without one is sent back once to
  write it.
- VS Code fills its commit box from `SQUASH_MSG` only while the box is empty: clear it to see a newly prepared
  message. A prepared commit you don't make stays staged, and its message stays in `.git/SQUASH_MSG`, until Braun
  prepares the next one or you unstage and delete it yourself.

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
