import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'vitest'

// Scaffolds a miniature of the repo layout (both action files naming their
// bundle, both bundles present and tracked) and asserts the behaviors the
// verify gate exists for: tracked drift fails, an untracked output fails,
// dirt outside the output directories passes, and a bundle rename that an
// action file did not follow fails. CI only ever exercises the clean path.
const script = join(import.meta.dirname, '../scripts/verify-dist.mjs')

let root: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
}

function verify(): number {
  try {
    execFileSync('node', [script], { cwd: root, stdio: 'pipe' })
    return 0
  } catch (err) {
    return (err as { status: number }).status
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-dist-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, 'review/dist'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'action.yml'), "runs:\n  main: 'dist/index.cjs'\n")
  writeFileSync(join(root, 'review/action.yml'), 'run: node "$GITHUB_ACTION_PATH/dist/review.cjs"\n')
  writeFileSync(join(root, 'dist/index.cjs'), 'gate bundle\n')
  writeFileSync(join(root, 'review/dist/review.cjs'), 'review bundle\n')
  writeFileSync(join(root, 'src/index.ts'), 'export {}\n')
  git('init')
  git('add', '.')
  git('commit', '-m', 'init')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test('passes a clean tree', { timeout: 20_000 }, () => {
  expect(verify()).toBe(0)
})

test('fails on tracked artifact drift', { timeout: 20_000 }, () => {
  appendFileSync(join(root, 'dist/index.cjs'), 'stale byte\n')
  expect(verify()).toBe(1)
})

test('fails on an untracked new artifact', { timeout: 20_000 }, () => {
  writeFileSync(join(root, 'review/dist/review.cjs.map'), 'source map\n')
  expect(verify()).toBe(1)
})

test('ignores dirt outside the output directories', { timeout: 20_000 }, () => {
  appendFileSync(join(root, 'src/index.ts'), 'export const x = 1\n')
  expect(verify()).toBe(0)
})

test('fails when an action file stops naming its bundle', { timeout: 20_000 }, () => {
  writeFileSync(join(root, 'action.yml'), "runs:\n  main: 'dist/renamed.cjs'\n")
  expect(verify()).toBe(1)
})
