import { expect, test } from 'claude-code/testing'

import {
  assembleMaterial, buildReport, matchPaths, MATERIAL_CAP, outcomeOf, parseGuard, parseVerdict,
} from '../hooks/guard'

test('a guard with a flow list of paths', async () => {
  const guard = parseGuard('py', '---\nother: 1\npaths: ["src/**/*.py", \'lib/*.ts\', docs/*.md]\n---\nNo prints.\n')
  expect(guard).toEqual({ name: 'py', text: 'No prints.', paths: ['src/**/*.py', 'lib/*.ts', 'docs/*.md'] })
})

test('a guard with a block list of paths', async () => {
  const guard = parseGuard('b', '---\npaths:\n  - "src/**"\n  - lib/*.ts\nname: x\n---\nText\nmore')
  expect(guard).toEqual({ name: 'b', text: 'Text\nmore', paths: ['src/**', 'lib/*.ts'] })
})

test('a guard that cannot be used says why', async () => {
  for (const content of [
    'Just text, no frontmatter',
    '---\npaths: ["a"]\nno end',
    '---\nname: x\n---\nText',
    '---\npaths: []\n---\nText',
    '---\npaths:\nother: 1\n---\nText',
    '---\npaths: ["a"]\n---\n',
  ]) expect('invalid' in parseGuard('g', content)).toBe(true)
})

test('globs match the committed paths relative to the root', async () => {
  const paths = ['src/a/b.py', 'src/c.py', 'lib/x.ts', 'lib/deep/y.ts', 'README.md']
  expect(matchPaths(['src/**/*.py', 'lib/*.ts'], paths, '/r')).toEqual(['src/a/b.py', 'src/c.py', 'lib/x.ts'])
  expect(matchPaths(['docs/**'], paths, '/r')).toEqual([])
})

test('material past the cap is cut and marked partial', async () => {
  const small = assembleMaterial('+a', [{ path: 'a.ts', content: 'x' }, { path: 'gone.ts', content: undefined }])
  expect(small.partial).toBe(false)
  expect(small.text).toContain('deleted in this commit')
  const big = assembleMaterial('+a', [{ path: 'a.ts', content: 'x'.repeat(MATERIAL_CAP) }])
  expect(big.partial).toBe(true)
  expect(big.text.length).toBe(MATERIAL_CAP)
})

test('verdicts', async () => {
  expect(parseVerdict('PASS\nfine')).toEqual({ status: 'PASS', detail: 'fine' })
  expect(parseVerdict('\n  fail: print at src/a.py:3\nmore').status).toBe('FAIL')
  expect(parseVerdict('n/a - nothing here').status).toBe('N/A')
  expect(parseVerdict('Passed the check').status).toBe('unclear')
  expect(parseVerdict('Sure! PASS').status).toBe('unclear')
  expect(parseVerdict('').status).toBe('unclear')
  expect(parseVerdict('x'.repeat(2000)).detail.length).toBe(400)
})

test('a completion that did not answer is never a pass', async () => {
  expect(outcomeOf('g', { isAnswered: false, reason: 'api-error', status: 529 }, false))
    .toEqual({ name: 'g', status: 'did not run', partial: false, detail: 'api-error (status 529)' })
  expect(outcomeOf('g', { isAnswered: false, reason: 'aborted' }, false).status).toBe('did not run')
})

test('the report for a mix of outcomes', async () => {
  const report = buildReport([
    { name: 'a', status: 'PASS', detail: 'ok' },
    { name: 'b', status: 'FAIL', detail: 'src/x.py:3 prints' },
    { name: 'c', status: 'unclear', detail: 'maybe' },
    { name: 'd', status: 'did not run', detail: 'aborted' },
    { name: 'e', status: 'invalid', detail: '"paths" is empty' },
    { name: 'f', status: 'N/A', partial: true },
  ], 6)
  expect(report.split('\n')[0]).toContain('Guardian report (advisory')
  expect(report).toContain('- a: PASS')
  expect(report).not.toContain('ok')
  expect(report).toContain('- b: FAIL\n    src/x.py:3 prints')
  expect(report).toContain('- d: did not run')
  expect(report).toContain('- e: invalid: "paths" is empty')
  expect(report).toContain('- f: N/A [partial review')
  expect(buildReport([], 2)).toContain('No guard matches')
})
