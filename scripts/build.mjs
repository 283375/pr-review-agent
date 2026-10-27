import { build } from 'esbuild'
import { artifacts } from './artifacts.mjs'

// logLevel 'warning': esbuild diagnostics (import.meta in CJS output,
// indirect require) reach stderr like the CLI printed them; only the size
// summary is skipped.
for (const { entry, outfile } of artifacts) {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile, logLevel: 'warning' })
  console.log(outfile)
}
