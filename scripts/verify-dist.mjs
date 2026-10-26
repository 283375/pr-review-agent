import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { artifacts, gateRoots } from './artifacts.mjs'

// Run from the package root (the way npm/pnpm scripts execute): every path
// is resolved against the working directory.
const root = process.cwd()

// git diff cannot see untracked outputs, so a newly appearing artifact
// (extra entry bundle, sourcemap) would pass a diff-only gate; porcelain
// status covers tracked drift and untracked files in one call.
const status = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...gateRoots],
  { encoding: 'utf8', cwd: root },
)
if (status.trim() !== '') {
  console.error('dist outputs are not up to date:\n' + status)
  process.exit(1)
}

// Coverage must not shrink when the manifest does: a tracked bundle left
// behind by a move (copy + edit instead of git rm) would otherwise sit
// outside the gate forever. Every tracked file under a gate root must be a
// manifest outfile.
const outfiles = new Set(artifacts.map((a) => a.outfile))
const tracked = execFileSync('git', ['ls-files', '--', ...gateRoots], {
  encoding: 'utf8',
  cwd: root,
})
  .split('\n')
  .filter(Boolean)
const stale = tracked.filter((f) => !outfiles.has(f))
if (stale.length > 0) {
  console.error('tracked files under the gate roots are not manifest outputs:\n' + stale.join('\n'))
  process.exit(1)
}

for (const a of artifacts) {
  if (!existsSync(resolve(root, a.outfile))) {
    console.error(`missing build output: ${a.outfile}`)
    process.exit(1)
  }
  if (!a.action) continue
  const text = readFileSync(resolve(root, a.action), 'utf8')
  if (!text.includes(a.actionRef)) {
    console.error(`${a.action} no longer names '${a.actionRef}' — update scripts/artifacts.mjs when a bundle moves`)
    process.exit(1)
  }
  if (resolve(root, dirname(a.action), a.actionRef) !== resolve(root, a.outfile)) {
    console.error(`'${a.actionRef}' in ${a.action} does not resolve to ${a.outfile}`)
    process.exit(1)
  }
}
