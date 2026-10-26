// Single source for the committed bundles: build.mjs produces these files,
// verify-dist.mjs gates them, and both action.yml entry points must keep
// naming them. `actionRef` is the path as written in that action file —
// GitHub loads action.yml literally, so it cannot import this manifest;
// the verify gate fails the build when the two drift apart (which is how
// the review bundle once moved without the gate noticing).
export const artifacts = [
  { entry: 'src/main.ts', outfile: 'dist/index.cjs', action: 'action.yml', actionRef: 'dist/index.cjs' },
  { entry: 'src/review/entry.ts', outfile: 'review/dist/review.cjs', action: 'review/action.yml', actionRef: 'dist/review.cjs' },
]
