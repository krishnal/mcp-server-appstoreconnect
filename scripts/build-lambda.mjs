/**
 * Bundle the Lambda entry point into a single-file ESM artifact.
 *
 *   npm run build:lambda   →  dist/lambda/index.mjs (+ sourcemap)
 *
 * Zip dist/lambda and upload, or point SAM/Serverless/Terraform at it.
 * (template.yaml uses SAM's own esbuild integration instead — either works.)
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/lambda-handler.ts'],
  outfile: 'dist/lambda/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: true,
  // ESM bundles still need `require` for transitive CJS deps (pino et al.).
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

console.log('Lambda bundle written to dist/lambda/index.mjs');
