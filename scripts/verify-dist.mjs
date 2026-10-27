import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { artifacts, gateRoots } from './artifacts.mjs'

// Run from the package root (the way npm/pnpm scripts execute): every path
// is resolved against the working directory.
const root = process.cwd()

// The gate's git visibility is the union of the fixed coverage roots and
// every directory the manifest outputs into: gateRoots keeps coverage stable
// when artifacts move, the manifest entries keep it current when artifacts
// are added. '.' is excluded so the pathspec never widens to the whole
// repository — dirt outside the outputs must not fail the gate.
const roots = [
  ...new Set([
    ...gateRoots,
    ...artifacts.map((a) => dirname(a.outfile)).filter((d) => d !== '.'),
  ]),
]

// git diff cannot see untracked outputs, so a newly appearing artifact
// (extra entry bundle, sourcemap) would pass a diff-only gate; porcelain
// status covers tracked drift and untracked files in one call.
const status = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...roots],
  { encoding: 'utf8', cwd: root },
)
if (status.trim() !== '') {
  console.error('dist outputs are not up to date:\n' + status)
  process.exit(1)
}

// Coverage must not shrink when the manifest does: a tracked bundle left
// behind by a move (copy + edit instead of git rm) would otherwise sit
// outside the gate forever. Every tracked file under the gate roots must be
// a manifest outfile.
const outfiles = new Set(artifacts.map((a) => a.outfile))
const tracked = execFileSync('git', ['ls-files', '--', ...roots], {
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

// Every bundle must be referenced by its action file's functional line — a
// YAML `main:` value or a `$GITHUB_ACTION_PATH/` argument. Comments are
// stripped before matching: whole-line `#` comments and, quote-aware, ` #`
// trailing comments, so neither a commented-out old value nor a trailing
// "was <old path>" note can satisfy the check.
function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let quote
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote) {
          if (ch === quote) quote = undefined
        } else if (ch === "'" || ch === '"') {
          quote = ch
        } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

for (const a of artifacts) {
  if (!existsSync(resolve(root, a.outfile))) {
    console.error(`missing build output: ${a.outfile}`)
    process.exit(1)
  }
  const functional = stripComments(readFileSync(resolve(root, a.action), 'utf8'))
  const refs = [...functional.matchAll(/^\s*main:\s*['"]?([^'"\s#]+)['"]?|\$GITHUB_ACTION_PATH\/([\w./-]+)/gm)].map((m) => m[1] ?? m[2])
  if (!refs.includes(a.actionRef)) {
    console.error(`${a.action} has no functional reference to '${a.actionRef}' — update scripts/artifacts.mjs when a bundle moves`)
    process.exit(1)
  }
  if (resolve(root, dirname(a.action), a.actionRef) !== resolve(root, a.outfile)) {
    console.error(`'${a.actionRef}' in ${a.action} does not resolve to ${a.outfile}`)
    process.exit(1)
  }
  if (a.actionRoot && resolve(root, dirname(a.outfile), a.actionRoot) !== root) {
    console.error(`${a.outfile}: actionRoot '${a.actionRoot}' does not resolve to the repository root`)
    process.exit(1)
  }
}
