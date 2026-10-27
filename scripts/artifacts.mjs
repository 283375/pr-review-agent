// Single source for the committed bundles: build.mjs produces these files,
// verify-dist.mjs gates them, and both action.yml entry points must keep
// naming them. `actionRef` is the path as written in that action file —
// GitHub loads action.yml literally, so it cannot import this manifest;
// the verify gate fails the build when the two drift apart (which is how
// the review bundle once moved without the gate noticing).
// The path from a bundle's directory back to the repository root — the root
// that prompts/, pi/, gondolin/ and node_modules resolve against.
const actionRootFor = (outfile) => '../'.repeat(outfile.split('/').length - 1) || '.'

export const artifacts = [
  { entry: 'src/main.ts', outfile: 'dist/index.cjs', action: 'action.yml', actionRef: 'dist/index.cjs' },
  {
    entry: 'src/review/entry.ts',
    outfile: 'review/dist/review.cjs',
    action: 'review/action.yml',
    actionRef: 'dist/review.cjs',
    actionRoot: actionRootFor('review/dist/review.cjs'),
  },
]

// The review pipeline bundle. src/review/main.ts resolves its actionRoot
// from this entry at build time, so moving the bundle moves the root with
// it instead of silently breaking the runtime lookups listed above.
export const reviewArtifact = artifacts[1]

// Coverage roots the verify gate checks in full, independent of where the
// current outfiles live: every tracked file under a root must be a manifest
// outfile, so a bundle that moves without git rm-ing the old path fails the
// gate instead of hiding outside it.
export const gateRoots = ['dist', 'review/dist']
