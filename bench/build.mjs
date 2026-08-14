/* eslint-disable no-console */
/**
 * Bundles the ingest benchmark for plain Node.
 *
 * The model layer is written for Vite, so a few of its conventions have to be
 * reproduced here: the `@` alias, Vite's `?raw` import suffix for shaders, and
 * `import.meta.env`. None of this changes the code under test — it only makes
 * the renderer's modules loadable outside a browser.
 */
import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolves Vite's `foo.glsl?raw` imports to the plain file, loaded as text. */
const viteRawPlugin = {
  name: 'vite-raw',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'file',
    }));
  },
};

await build({
  entryPoints: [path.join(root, 'bench/ingest.bench.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: path.join(root, 'bench/dist/ingest.bench.mjs'),
  alias: { '@': path.join(root, 'src') },
  inject: [path.join(root, 'bench/shim.cjs')],
  plugins: [viteRawPlugin],
  loader: {
    '.glsl': 'text',
    '.vert': 'text',
    '.frag': 'text',
    '.png': 'dataurl',
    '.svg': 'text',
    '.gltf': 'json',
  },
  define: {
    'import.meta.env': JSON.stringify({ VITE_STATIC_URL: '/' }),
  },
  banner: {
    // Some transitive dependencies (axios) are CommonJS and call require() at
    // load time, which an ESM bundle otherwise has no binding for.
    js: "import { createRequire as __createRequire } from 'module';\n"
      + 'const require = __createRequire(import.meta.url);',
  },
  logLevel: 'warning',
});

console.log('built bench/dist/ingest.bench.mjs');
