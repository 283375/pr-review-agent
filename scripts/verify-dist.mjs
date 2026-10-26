import { execFileSync } from 'node:child_process'

// git diff cannot see untracked outputs, so a newly appearing artifact
// (extra entry bundle, sourcemap) would pass a diff-only gate; porcelain
// status covers tracked drift and untracked files in one call.
const out = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', 'dist', 'review/dist'],
  { encoding: 'utf8' },
)
if (out.trim() !== '') {
  console.error('dist/ or review/dist/ is not up to date:\n' + out)
  process.exit(1)
}
