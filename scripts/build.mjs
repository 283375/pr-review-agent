import { build } from 'esbuild'
import { artifacts } from './artifacts.mjs'

for (const { entry, outfile } of artifacts) {
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile, logLevel: 'silent' })
  console.log(outfile)
}
