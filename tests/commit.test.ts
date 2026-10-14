import { expect, test } from 'claude-code/testing'

import { checkCommit, isOurs, MARKER, messageProblem, squashMessage, statusPaths } from '../hooks/commit'

const CHANGED = ['hooks/register.ts', 'README.md', 'docs/new file.md']

test('a valid commit request', async () => {
  const checked = checkCommit({ paths: ['hooks/register.ts', 'README.md', 'README.md'], message: 'feat(hooks): stage at hand-back\n' }, CHANGED)
  expect(checked).toEqual({ request: { paths: ['hooks/register.ts', 'README.md'], message: 'feat(hooks): stage at hand-back' } })
})

test('a commit request is refused for unknown, empty or malformed paths', async () => {
  expect('problem' in checkCommit({ paths: ['src/other.ts'], message: 'fix: x' }, CHANGED)).toBe(true)
  expect('problem' in checkCommit({ paths: ['./README.md'], message: 'fix: x' }, CHANGED)).toBe(true)
  expect('problem' in checkCommit({ paths: [], message: 'fix: x' }, CHANGED)).toBe(true)
  expect('problem' in checkCommit({ paths: 'README.md', message: 'fix: x' }, CHANGED)).toBe(true)
  expect('problem' in checkCommit({ paths: ['README.md'] }, CHANGED)).toBe(true)
  expect('problem' in checkCommit(undefined, CHANGED)).toBe(true)
  expect('problem' in checkCommit({ paths: ['README.md'], message: 'update readme' }, CHANGED)).toBe(true)
})

test('Conventional Commits messages', async () => {
  for (const message of [
    'feat: add the thing',
    'fix(hooks): handle renames',
    'refactor!: drop the old API',
    'chore(deps)!: bump everything',
    'docs: explain staging\n\nVS Code reads SQUASH_MSG into its commit box.\nGit deletes it after the commit.',
  ]) expect(messageProblem(message)).toBeUndefined()
  for (const message of [
    'feature: add the thing',
    'Feat: add the thing',
    'feat add the thing',
    'feat:add the thing',
    'feat(): add the thing',
    'feat(two words): add the thing',
    'feat:  ',
    '',
    `feat: ${'x'.repeat(67)}`,
    'feat: subject\nbody right below',
  ]) expect(messageProblem(message)).toBeDefined()
  expect(messageProblem(`feat: ${'x'.repeat(66)}`)).toBeUndefined()
})

test('paths from git status --porcelain=v1 -z', async () => {
  const porcelain = [' M hooks/register.ts', '?? docs/new file.md', ' D old.txt', 'R  new.ts', 'was.ts', 'A  added.ts', ''].join('\0')
  expect(statusPaths(porcelain)).toEqual(['hooks/register.ts', 'docs/new file.md', 'old.txt', 'new.ts', 'was.ts', 'added.ts'])
  expect(statusPaths('')).toEqual([])
})

test('SQUASH_MSG content and the marker', async () => {
  const content = squashMessage('fix: x\n\nbody\n')
  expect(content).toBe(`fix: x\n\nbody\n\n${MARKER}\n`)
  expect(isOurs(content)).toBe(true)
  expect(isOurs('Squashed commit of the following:\n\ncommit abc\n')).toBe(false)
  expect(isOurs('')).toBe(false)
})
