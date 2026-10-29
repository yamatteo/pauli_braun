import { expect, test } from 'claude-code/testing'

import {
  allowedCommand, allowedPath, checkBash, checkEdit, decide, gitChange, globalInstall, inScratch, touchesClaudeDir,
  type PathContext, type PathFacts, type Role, type Target,
} from '../hooks/rules'

const allowed = (role: Role, command: string) => expect(checkBash(command, role).deny).toBeUndefined()
const blocked = (role: Role, command: string) => expect(checkBash(command, role).deny).toBeDefined()

test('Pauli reads, searches and runs tests', async () => {
  for (const command of [
    'git status --short',
    'git log --oneline -20 | head',
    'git -C sub diff HEAD~1 -- src/',
    'git branch -a',
    'git branch --contains abc123',
    'git stash list',
    'git config --get user.name',
    'git fetch origin',
    'uv run pytest -q 2>&1 | tail -20',
    'npm --prefix frontend run type-check',
    'grep -rn "a > b" src/ 2>/dev/null',
    'find . -name "*.py" -not -path "./.venv/*"',
    'ls -la && cat README.md >&2',
    'python -c "print(1)"',
  ]) allowed('pauli', command)
})

test('Pauli is refused the obvious side effects', async () => {
  for (const command of [
    'git commit -m "x"',
    'git checkout -- file.py',
    'git branch new-feature',
    'git stash',
    'git apply fix.patch',
    'echo hi > notes.txt',
    'cat a >> b',
    'sed -i "s/a/b/" file.py',
    'rm -rf build',
    'mkdir out',
    'tee log.txt < input',
    'npm install',
    'uv add requests',
    'pip install -e .',
    'python -m pip install x',
    'find . -name "*.pyc" -delete',
    'find . -exec rm {} \\;',
    'bash -c "git push"',
    'echo $(git reset --hard)',
    'cat <<EOF > out.txt\nhello > there\nEOF',
  ]) blocked('pauli', command)
})

// Braun's paths resolve from the session's directory, with these values for `~`, $HOME and $TMPDIR.
const CTX: PathContext = { cwd: '/repo', home: '/home/u', tmpdir: '/var/tmp/x' }
const targets = (command: string, ctx: PathContext = CTX) => {
  const verdict = checkBash(command, 'braun', ctx)
  expect(verdict.deny).toBeUndefined()
  return verdict.targets
}
const braunBlocked = (command: string, ctx: PathContext = CTX) => expect(checkBash(command, 'braun', ctx).deny).toBeDefined()
const w = (path: string, sources?: string[]): Target => (sources === undefined ? { path, op: 'write' } : { path, op: 'write', sources })
const r = (path: string): Target => ({ path, op: 'remove' })

test('Braun builds and installs locally but leaves git alone', async () => {
  for (const command of [
    'git diff',
    'npm install',
    'npm i -D vitest',
    'pnpm add zod',
    'yarn add left-pad',
    'bun install',
    'uv add requests',
    'uv sync',
    'uv pip install -e .',
    'poetry add httpx',
    '.venv/bin/pip install -r requirements.txt',
    'venv/bin/python -m pip install x',
    'cargo add serde',
    'git apply fix.patch',
    'patch -p1 < fix.patch',
    'apt list --installed',
    'npm -g ls',
  ]) expect(checkBash(command, 'braun', CTX).deny).toBeUndefined()
  for (const command of [
    'git commit -am wip',
    'git add .',
    'git reset --hard',
    'git clean -fdx',
    'git stash push',
    'git checkout main',
    'git restore file.py',
    'git push --force',
    'git branch -D old',
    'git tag v1',
    'cd sub && git rebase -i HEAD~3',
    'find . -delete',
    'find . -name "*.o" -exec rm {} +',
    'git ls-files | xargs rm',
    'ls | xargs -I{} mv {} old/',
  ]) braunBlocked(command)
})

test('Braun global installs and sudo need the brief', async () => {
  for (const command of [
    'npm install -g typescript',
    'npm i --global x',
    'pnpm add -g x',
    'yarn global add x',
    'pip install requests',
    'pip3 uninstall x',
    'python3 -m pip install x',
    '.venv/bin/pip install --user x',
    'pipx install ruff',
    'uv tool install ruff',
    'uv python install 3.12',
    'uv pip install --system x',
    'cargo install ripgrep',
    'go install example.com/x@latest',
    'gem install rails',
    'apt-get install -y jq',
    'apt install jq',
    'dnf install jq',
    'pacman -Syu',
    'brew install jq',
    'snap install code',
    'conda install numpy',
    'mamba create -n x',
    'sudo ls',
    'doas make install',
    'timeout 60 sudo -n true',
  ]) braunBlocked(command)
  expect(globalInstall(['pip', 'install', 'x'])).toBe('pip install outside a virtual environment')
  expect(globalInstall(['pacman', '-Ss', 'jq'])).toBeUndefined()
  expect(globalInstall(['npm', 'install'])).toBeUndefined()
  // A prefix the brief allows, word by word, against the command as written or past its wrappers.
  const allow: PathContext = { ...CTX, allowCommands: ['cargo install ripgrep', 'sudo apt-get install'] }
  expect(checkBash('cargo install ripgrep --locked', 'braun', allow).deny).toBeUndefined()
  expect(checkBash('timeout 600 cargo install ripgrep', 'braun', allow).deny).toBeUndefined()
  expect(checkBash('sudo apt-get install -y jq', 'braun', allow).deny).toBeUndefined()
  expect(checkBash('cargo install ripgrep-all', 'braun', allow).deny).toBeDefined()
  expect(checkBash('sudo apt-get remove jq', 'braun', allow).deny).toBeDefined()
  expect(allowedCommand(['npm', 'install', '-g', 'x'], ['npm install -g'])).toBe(true)
  expect(allowedCommand(['npm', 'install', 'x'], ['npm install -g'])).toBe(false)
  expect(allowedCommand(['npm'], [' '])).toBe(false)
})

test('Braun commands name what they write and remove', async () => {
  expect(targets('echo hi > notes.txt')).toEqual([w('/repo/notes.txt')])
  expect(targets('echo x > .git/HEAD')).toEqual([w('/repo/.git/HEAD')])
  expect(targets('make 2>/dev/null >> log/a.txt 2>&1')).toEqual([w('/repo/log/a.txt')])
  expect(targets('{ echo a; echo b; } > out.txt')).toEqual([w('/repo/out.txt')])
  expect(targets('cat x | tee -a out.log /dev/null')).toEqual([w('/repo/out.log')])
  expect(targets('sed -i.bak -e "s/a/b/" a.py b.py')).toEqual([w('/repo/a.py'), w('/repo/b.py')])
  expect(targets('sed -i "s/a/b/" f.py')).toEqual([w('/repo/f.py')])
  expect(targets('sed -ni "s/a/b/p" f.py')).toEqual([w('/repo/f.py')])
  expect(targets('sed -n "s/a/b/p" f.py')).toEqual([])
  expect(targets('perl -pi -e "s/a/b/" x.pl')).toEqual([w('/repo/x.pl')])
  expect(targets('perl -lne "print" f')).toEqual([])
  expect(targets('cp -r src dest')).toEqual([w('/repo/dest', ['src'])])
  expect(targets('cp -t out a b')).toEqual([w('/repo/out', ['a', 'b'])])
  expect(targets('mv a.py b.py')).toEqual([r('/repo/a.py'), w('/repo/b.py', ['a.py'])])
  expect(targets('mv -t dest a b')).toEqual([r('/repo/a'), r('/repo/b'), w('/repo/dest', ['a', 'b'])])
  expect(targets('install -m 644 a.conf etc/')).toEqual([w('/repo/etc', ['a.conf'])])
  expect(targets('install -d d1 d2')).toEqual([w('/repo/d1'), w('/repo/d2')])
  expect(targets('ln -s ../shared/target')).toEqual([w('/repo/target')])
  expect(targets('ln -sf /x/y link')).toEqual([w('/repo/link', ['/x/y'])])
  expect(targets('rsync -a src/ host:dst/')).toEqual([])
  expect(targets('rsync -a --remove-source-files -e ssh a b/')).toEqual([r('/repo/a'), w('/repo/b', ['a'])])
  expect(targets('rm -rf build tmp.txt')).toEqual([r('/repo/build'), r('/repo/tmp.txt')])
  expect(targets('rm -- -weird')).toEqual([r('/repo/-weird')])
  expect(targets('unlink x; rmdir d; shred -u -n 3 f')).toEqual([r('/repo/x'), r('/repo/d'), r('/repo/f')])
  expect(targets('dd if=/dev/zero of=disk.img bs=1M')).toEqual([w('/repo/disk.img')])
  expect(targets('chmod +x run.sh')).toEqual([w('/repo/run.sh')])
  expect(targets('chmod -R -x a b')).toEqual([w('/repo/a'), w('/repo/b')])
  expect(targets('chmod --reference=ref f')).toEqual([w('/repo/f')])
  expect(targets('chown u:g f')).toEqual([w('/repo/f')])
  expect(targets('mkdir -p -m 755 a/b')).toEqual([w('/repo/a/b')])
  expect(targets('touch -d now f')).toEqual([w('/repo/f')])
  expect(targets('truncate -s 0 f')).toEqual([w('/repo/f')])
  expect(targets('git apply fix.patch')).toEqual([])
})

test('Braun paths: cd, ~, $HOME, $TMPDIR, and what cannot be resolved', async () => {
  expect(targets('cd sub && touch a')).toEqual([w('/repo/sub/a')])
  expect(targets('cd /etc; touch b')).toEqual([w('/etc/b')])
  expect(targets('cd && rm x')).toEqual([r('/home/u/x')])
  expect(targets('cd .. && touch c')).toEqual([w('/c')])
  expect(targets('bash -c "cd sub && rm a"; rm b')).toEqual([r('/repo/sub/a'), r('/repo/b')])
  expect(targets('touch ~/f ./a/../b')).toEqual([w('/home/u/f'), w('/repo/b')])
  expect(targets('rm $TMPDIR/x ${HOME}/y')).toEqual([r('/var/tmp/x/x'), r('/home/u/y')])
  // A variable or a pattern is fine only inside a scratch folder: the path is then that folder.
  expect(targets('rm -rf /tmp/build-*')).toEqual([r('/tmp')])
  expect(targets('rm -rf $TMPDIR/*')).toEqual([r('/var/tmp/x')])
  expect(targets('cd /tmp/work && rm -f *.o')).toEqual([r('/tmp/work')])
  for (const command of [
    'rm $X',
    'rm *.log',
    'touch ~bob/x',
    'rm /tmp/../etc/*',
    'rm /tmp/$X/../../etc/passwd',
    'rm /tmp*',
    'cd $X && touch d',
    'cd - && touch d',
    'echo x > "$OUT"',
    'cp a `pwd`/b',
  ]) braunBlocked(command)
  // Without a known home, `~` cannot be resolved.
  braunBlocked('touch ~/f', { cwd: '/repo' })
})

test('scratch folders and the brief\'s globs', async () => {
  expect(inScratch('/tmp', CTX)).toBe(true)
  expect(inScratch('/tmp/a/b', CTX)).toBe(true)
  expect(inScratch('/private/tmp/a', CTX)).toBe(true)
  expect(inScratch('/var/tmp/x/s', CTX)).toBe(true)
  expect(inScratch('/var/tmp/y', CTX)).toBe(false)
  expect(inScratch('/tmpfoo', CTX)).toBe(false)
  expect(inScratch('/x', { tmpdir: '/' })).toBe(false)
  expect(allowedPath('/repo/docs/a.md', ['docs/*.md'], '/repo')).toBe(true)
  expect(allowedPath('/repo/docs/sub/a.md', ['docs/*.md'], '/repo')).toBe(false)
  expect(allowedPath('/repo/docs/sub/a.md', ['docs/**/*.md'], '/repo')).toBe(true)
  expect(allowedPath('/repo/docs/a.md', ['docs/**/*.md'], '/repo')).toBe(true)
  expect(allowedPath('/repo/old', ['old/**'], '/repo')).toBe(true)
  expect(allowedPath('/repo/old/x/y', ['./old/**'], '/repo')).toBe(true)
  expect(allowedPath('/repo/older', ['old/**'], '/repo')).toBe(false)
  expect(allowedPath('/repo/a1.txt', ['a?.txt'], '/repo')).toBe(true)
  expect(allowedPath('/repo/a12.txt', ['a?.txt'], '/repo')).toBe(false)
  expect(allowedPath('/repo/axb', ['a.b'], '/repo')).toBe(false)
  expect(allowedPath('/home/u/.config/tool/x', ['/home/u/.config/tool/**'], '/repo')).toBe(true)
  expect(allowedPath('/home/u/.config/other', ['/home/u/.config/tool/**'], '/repo')).toBe(false)
})

test('the decision order for each path Braun writes or removes', async () => {
  const none: PathFacts = {
    scratch: false, allowed: false, inGit: false, outside: false, ignored: false, tracked: false, dirty: false,
    untrackedAtStart: false, directory: false, holdsIgnored: false,
  }
  const ok = (op: 'write' | 'remove', facts: Partial<PathFacts>) => expect(decide('/p', op, { ...none, ...facts })).toBeUndefined()
  const no = (op: 'write' | 'remove', facts: Partial<PathFacts>) => expect(decide('/p', op, { ...none, ...facts })).toBeDefined()
  // 1. scratch, 2. allowed: before anything else.
  ok('remove', { scratch: true, outside: true, ignored: true })
  ok('remove', { allowed: true, inGit: true, untrackedAtStart: true })
  // 3. .git, 4. outside, 5. ignored.
  no('write', { inGit: true })
  no('write', { outside: true })
  no('write', { ignored: true })
  no('remove', { ignored: true })
  // 6. tracked: written freely, even dirty; removed only when clean.
  ok('write', { tracked: true })
  ok('write', { tracked: true, dirty: true })
  ok('remove', { tracked: true })
  no('remove', { tracked: true, dirty: true })
  ok('remove', { tracked: true, directory: true })
  no('remove', { tracked: true, directory: true, dirty: true })
  no('remove', { tracked: true, directory: true, holdsIgnored: true })
  no('remove', { tracked: true, directory: true, untrackedAtStart: true })
  // 7. untracked since before the run.
  no('write', { untrackedAtStart: true })
  no('remove', { untrackedAtStart: true })
  no('remove', { directory: true, untrackedAtStart: true })
  // 8. new, or created during this run (a directory holding ignored files excepted).
  ok('write', {})
  ok('remove', {})
  ok('remove', { directory: true })
  no('remove', { directory: true, holdsIgnored: true })
})

test('edits: Pauli never, Braun outside .git', async () => {
  expect(checkEdit('Edit', 'src/app.py', 'pauli')).toBeDefined()
  expect(checkEdit('Edit', 'src/app.py', 'braun')).toBeUndefined()
  expect(checkEdit('Write', '/repo/.git/config', 'braun')).toBeDefined()
  expect(checkEdit('Write', '/repo/.github/workflows/ci.yml', 'braun')).toBeUndefined()
})

test('git global options before the subcommand', async () => {
  expect(gitChange(['--no-pager', '-c', 'core.x=y', 'log'], 'braun')).toBeUndefined()
  expect(gitChange(['-C', '/tmp/r', 'commit', '-m', 'x'], 'braun')).toBe('git commit')
})

test('.claude is Braun\'s no-go, by path segment', async () => {
  const root = '/home/u/proj'
  expect(touchesClaudeDir(`${root}/.claude`, 'write', root)).toBe(true)
  expect(touchesClaudeDir(`${root}/.claude/guards/a.md`, 'write', root)).toBe(true)
  expect(touchesClaudeDir(`${root}/.claude/guards`, 'remove', root)).toBe(true)
  expect(touchesClaudeDir(root, 'remove', root)).toBe(true)
  expect(touchesClaudeDir('/home/u', 'remove', root)).toBe(true)
  expect(touchesClaudeDir('/', 'remove', root)).toBe(true)
  expect(touchesClaudeDir(root, 'write', root)).toBe(false)
  expect(touchesClaudeDir(`${root}/.claude-plugin/plugin.json`, 'write', root)).toBe(false)
  expect(touchesClaudeDir(`${root}/.claude-plugin`, 'remove', root)).toBe(false)
  expect(touchesClaudeDir(`${root}/src/.claude/x`, 'write', root)).toBe(false)
  expect(touchesClaudeDir(`${root}/src/a.ts`, 'remove', root)).toBe(false)
})
