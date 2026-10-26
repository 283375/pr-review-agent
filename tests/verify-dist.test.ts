import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { artifacts } from '../scripts/artifacts.mjs'

// Scaffolds a miniature of the repo layout from the manifest itself (each
// bundle present and tracked, each action file naming its bundle) and
// asserts the behaviors the verify gate exists for. CI only ever exercises
// the clean path, so the failure branches are asserted here directly.
const script = join(import.meta.dirname, '../scripts/verify-dist.mjs')

const firstArtifact = artifacts[0]
if (!firstArtifact) throw new Error('scripts/artifacts.mjs lists no artifacts')

let root: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
}

function verify(): { status: number; stderr: string } {
  try {
    execFileSync('node', [script], { cwd: root, stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status: number; stderr?: Buffer }
    return { status: e.status, stderr: e.stderr?.toString() ?? '' }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verify-dist-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/index.ts'), 'export {}\n')
  for (const a of artifacts) {
    mkdirSync(join(root, dirname(a.outfile)), { recursive: true })
    writeFileSync(join(root, a.outfile), `bundle for ${a.entry}\n`)
    mkdirSync(join(root, dirname(a.action)), { recursive: true })
    writeFileSync(join(root, a.action), `main: '${a.actionRef}'\n`)
  }
  git('init')
  git('add', '.')
  git('commit', '-m', 'init')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('passes a clean tree', { timeout: 20_000 }, () => {
  expect(verify()).toMatchObject({ status: 0 })
})

test('fails on tracked artifact drift', { timeout: 20_000 }, () => {
  appendFileSync(join(root, firstArtifact.outfile), 'stale byte\n')
  expect(verify()).toMatchObject({ status: 1 })
})

test('fails on an untracked new artifact', { timeout: 20_000 }, () => {
  writeFileSync(join(root, firstArtifact.outfile + '.map'), 'source map\n')
  expect(verify()).toMatchObject({ status: 1 })
})

test('fails on a tracked file the manifest does not list', { timeout: 20_000 }, () => {
  const stalePath = firstArtifact.outfile + '.old'
  writeFileSync(join(root, stalePath), 'left behind by a move\n')
  git('add', stalePath)
  git('commit', '-m', 'left behind')
  expect(verify()).toMatchObject({ status: 1 })
})

test('ignores dirt outside the output directories', { timeout: 20_000 }, () => {
  appendFileSync(join(root, 'src/index.ts'), 'export const x = 1\n')
  expect(verify()).toMatchObject({ status: 0 })
})

test('fails when an action file stops naming its bundle', { timeout: 20_000 }, () => {
  writeFileSync(join(root, firstArtifact.action), "main: 'moved.cjs'\n")
  expect(verify()).toMatchObject({ status: 1 })
})
