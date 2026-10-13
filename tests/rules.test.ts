import { expect, test } from 'claude-code/testing'

import { checkBash, checkEdit, gitChange, styleArgMode, type Role } from '../hooks/rules'

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

test('Braun edits and builds but leaves git alone', async () => {
  for (const command of [
    'git diff',
    'npm install',
    'uv add requests',
    'echo hi > notes.txt',
    'sed -i "s/a/b/" file.py',
    'mkdir -p src/new',
    'git apply fix.patch',
  ]) allowed('braun', command)
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
    'echo x > .git/HEAD',
    'rm -rf .git',
    'find . -delete',
    'git ls-files | xargs rm',
  ]) blocked('braun', command)
})

test('Braun rm and mv name the paths to check against git', async () => {
  expect(checkBash('rm -f build/tmp.txt other.log', 'braun').mustBeUntracked).toEqual(['build/tmp.txt', 'other.log'])
  expect(checkBash('mv a.py b.py', 'braun').mustBeUntracked).toEqual(['a.py'])
  expect(checkBash('mv -t dest a.py b.py', 'braun').mustBeUntracked).toEqual(['a.py', 'b.py'])
  expect(checkBash('rm -- -weird', 'braun').mustBeUntracked).toEqual(['-weird'])
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

test('the mode /output-style switches to', async () => {
  expect(styleArgMode('pauli-braun:pauli')).toBe('pauli')
  expect(styleArgMode('Pauli-Braun:BRAUN')).toBe('braun')
  expect(styleArgMode('default')).toBe('off')
  expect(styleArgMode('Explanatory')).toBe('off')
  expect(styleArgMode('')).toBeUndefined()
  expect(styleArgMode('   ')).toBeUndefined()
})
