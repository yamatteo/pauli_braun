# pauli-braun

A Claude Code plugin for a two-role workflow inside **one session thread**:

- **Pauli**, the skeptical architect: discusses, plans and reviews. Reads code and runs tests, but doesn't edit.
- **Braun**, the precision engineer: carries out the agreed brief, verifies it and reports. The only one who
  changes code. It never touches version control itself: when its work is done, the plugin stages it and prepares
  the commit message for you.

Each role is an output style, so the active mode is visible in the status line and in the system prompt. Hooks
guard what each role may do, and skills carry the hand-offs. There is no plan file: the conversation is the
record. When you trust Braun with a piece of work, `/delegate` runs it in a Braun subagent instead, so its effort
stays out of the thread.

## Install

```
/plugin marketplace add yamatteo/noodle_code_foundry
/plugin install pauli-braun@noodle-code-foundry
```

Pick a scope when asked (user scope makes it available in every project).

This repository no longer serves as a marketplace. If you installed `pauli-braun@pauli-braun`, uninstall it, remove the `pauli-braun` marketplace, and install from noodle-code-foundry as above.

## The cycle

1. **Discuss** with Pauli (`/pauli`) what to build and how.
2. **`/handoff [notes]`**: Pauli writes a *Brief for Braun* (goal, decisions, steps, what must not change,
   baseline, done-when, what Braun may do beyond its defaults, when to stop) and the session switches to Braun on
   its own. This is the only way to start Braun, and it needs a git repository: Braun's defaults are what git can
   restore.
   Or **`/delegate [notes]`**: Pauli writes a longer, self-contained brief straight into a Braun subagent, which it
   runs in the background (in the thread there is one line, `Delegating: <goal>`).
3. **Braun builds**, checks the done-when, writes a *report* and hands back to Pauli automatically, whether the work
   is done or blocked on something unexpected. A delegated Braun's report comes back to Pauli as its hand-back message.
4. **Pauli reviews** the report against the brief and the actual diff, and gives a verdict. Back to 1.

`/handoff` and `/delegate` are the only ways to start Braun: the plugin refuses a hand-off or a delegation the
user's command didn't start, so Pauli never starts Braun on its own.

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
| `/delegate [notes]` | From Pauli mode: write a self-contained brief for a Braun subagent, wait for its report, review it |

## Settings

The delegated Braun's model and effort, by default the session's:

| Setting | Values | Default |
| --- | --- | --- |
| `braunModel` | `inherit`, `haiku`, `sonnet`, `opus` | `inherit` (the session's model) |
| `braunEffort` | `inherit`, `low`, `medium`, `high`, `xhigh`, `max` | `inherit` (the session's effort) |

In a session, run `/plugin configure pauli-braun@noodle-code-foundry` (or `/plugin`, Installed tab, the plugin, **Configure options**). `pauli-braun@noodle-code-foundry` is the plugin ID when the marketplace is added as above;
if you added it under another name, use the ID `claude plugin list` shows.

From the shell, `claude plugin configure pauli-braun@noodle-code-foundry` lists the options and whether each is set, and `--values-stdin` saves values (it needs the full ID):

```sh
echo '{"braunModel":"sonnet","braunEffort":"high"}' | claude plugin configure pauli-braun@noodle-code-foundry --values-stdin
```

At install time, pass `--config` once per option:

```sh
claude plugin install pauli-braun@noodle-code-foundry --config braunModel=sonnet --config braunEffort=high
```

Or edit `~/.claude/settings.json` by hand:

```json
{ "pluginConfigs": { "pauli-braun@noodle-code-foundry": { "options": { "braunModel": "sonnet", "braunEffort": "high" } } } }
```

Restart Claude Code to apply a change. Project (`.claude/settings.json`) and local settings are ignored for plugin options: a cloned repository must not be able to supply them.

They don't touch `/handoff`: in-thread Braun runs on whatever the session runs on.

## Guards

In either mode, subagents and worktrees are refused (`Agent`, `Workflow`, `EnterWorktree`): everything stays in
the one thread, except the plugin's own Braun subagent, which the model is offered only within a delegation that
`/delegate` opened.

**Pauli** may read, search, run tests and run read-only git (`status`, `log`, `diff`, `show`, `blame`, `fetch`,
listing branches/tags/stashes, `config --get`…). Refused:

- file edits (`Edit`, `Write`, `NotebookEdit`);
- git commands that change the repository (see Braun) and `git clone`, `git apply` (except `--check`/`--stat`);
- file writers: `rm`, `mv`, `cp`, `mkdir`, `touch`, `ln`, `chmod`, `patch`, `rsync`…, `find -delete`, `find -exec`
  with any of these;
- redirections into files (`>`, `>>`; `/dev/null` and fd duplication are fine), `tee` into a file, `sed -i`,
  `perl -i`;
- package installs and removals (`npm install`, `uv add`, `pip install`, `cargo add`, `apt`…).

This covers the built-in tools: MCP tools are not guarded (see Known limits), so Pauli may call them.

**Starting Braun.** `/handoff` and `/delegate` (or their skills typed by full name, `/pauli-braun:handoff`,
`/pauli-braun:delegate`) unlock the matching tool for the turn they start, from Pauli mode only; the tool refuses
otherwise.

**Braun** works within a *run*, which `/handoff` or `/delegate` starts: the plugin notes the repository's root and
its untracked files at that moment, and the brief's **Allowed beyond the defaults** (passed as `allow`).

- In the thread, the run is recorded once the session has actually switched to Braun, and it ends at the next
  mode change. Switching to Braun's style by hand starts no run, and every write is then refused ("start Braun
  with /handoff or /delegate").
- Delegated, the delegate tool opens the delegation and measures its run; Pauli then makes one Agent call for the
  Braun subagent, which runs in the background. Any other Agent call for Braun is refused. The run belongs to that
  one subagent: the plugin applies Braun's rules to the subagent's calls, and the run ends when the subagent's turn
  ends, or when the plugin finds the subagent ended (completed, failed, killed or gone) without that turn's end
  reaching it. A delegation that spawned no subagent ends when the Agent call returns, or at the latest when Pauli's
  turn ends (which also ends one the Agent call never claimed). While a delegated Braun is working, a second
  `/delegate` and a `/handoff` to Braun are refused. The subagent prepares its commit through the hand-off tool,
  which then only stages and writes the message.

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
- The guards cover the built-in tools only. MCP tools pass in both modes: they act outside the working tree, and the
  engine cannot tell beforehand whether a call only reads.
- Output-style text is read when the plugin loads; after editing `output-styles/*.md`, restart Claude Code.
- Braun's paths:
  - **Relative paths** resolve from the session's directory. A literal `cd DIR` earlier on the same command line
    moves the base; a `cd` inside `( … )` still counts after the parentheses. A path after a `cd` the plugin
    can't follow (`cd "$X"`, `cd -`) is refused.
  - **Variables and patterns:** a path holding a variable, a substitution or a glob (`$OUT`, `*.log`) is refused,
    unless its literal folder is already a scratch one. Only `~`, `$HOME` and `$TMPDIR` are expanded.
  - **Symlinks:** a path is checked where it lands: links are followed, so a write through a link that leads out
    of the project is refused, and a link in a scratch folder is judged by where it leads, not by where it is spelled.
    A removal checks the link itself, not what it leads to. A path that leads nowhere resolvable is refused, and so
    is a dangling link, whose landing can't be determined.
  - **Unchecked targets:** `patch` and `git apply` (to the working tree) are allowed, with their targets unchecked.
    So are `xargs` and `find -exec` with writers other than removals. Files copied into a folder are checked by
    name, but the contents of a tree (`cp -r`, `rsync dir/`) aren't checked file by file.
- Every Braun turn ends with a report and a hand-back to Pauli: a turn that ends without one is sent back once to
  write it.
- A delegated Braun:
  - **Relative paths** resolve from the session's directory: a `cd` the subagent ran in an earlier command isn't
    seen (one earlier on the same command line is).
  - **One delegation, one run**: a Braun resumed by a message after its turn has ended has no run, so its writes
    are refused.
  - **Permissions**: the subagent runs under the session's permission mode, like any subagent the model starts.
- Not yet verified live: the whole `/delegate` round trip, from the spawn to the returned report.
- VS Code fills its commit box from `SQUASH_MSG` only while the box is empty: clear it to see a newly prepared
  message. A prepared commit you don't make stays staged, and its message stays in `.git/SQUASH_MSG`, until Braun
  prepares the next one or you unstage and delete it yourself.

## Developing

Load the plugin straight from a local clone:

```
claude --plugin-dir ~/pauli_braun
```

Edits apply after `/reload-plugins` (style text after a restart). Check and test with:

```
claude plugin validate .
claude plugin test .
```

## License

MIT
