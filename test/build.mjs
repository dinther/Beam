/* eslint-disable no-console */
/**
 * Bundles the tests for plain Node.
 *
 * The model layer is written for Vite, so a few of its conventions have to be
 * reproduced before Node can load it: the `@` alias, Vite's `?raw` import
 * suffix for shaders, and `import.meta.env`. None of this changes the code
 * under test -- it only makes the renderer's modules loadable outside a
 * browser. The same bargain `bench/build.mjs` makes, for the same reason.
 *
 * Every `*.test.js` beside this file is built, so adding a test is adding a
 * file rather than editing a list.
 *
 * Usage:
 *   node test/build.mjs
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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

/**
 * Vite's `foo?worker` imports, which node has no Worker for.
 *
 * `live.model` builds one at import time, so anything that reaches the show
 * model pulls a worker in whether or not the test drives DMX. The stub is a
 * class that does nothing: the tests never post to it, and a real worker here
 * would run the DMX thread beside them for no reason.
 */
const viteWorkerPlugin = {
  name: 'vite-worker',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?worker$/ }, (args) => ({
      path: args.path,
      namespace: 'vite-worker',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'vite-worker' }, () => ({
      contents: 'export default class Worker {'
        + ' postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }',
      loader: 'js',
    }));
  },
};

const entries = fs.readdirSync(here)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join(here, name));

if (!entries.length) {
  console.log('no tests to build');
  process.exit(0);
}

await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: path.join(here, 'dist'),
  outExtension: { '.js': '.mjs' },
  alias: { '@': path.join(root, 'src') },
  inject: [path.join(root, 'bench/shim.cjs')],
  plugins: [viteRawPlugin, viteWorkerPlugin],
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

entries.forEach((entry) => {
  console.log(`built test/dist/${path.basename(entry, '.js')}.mjs`);
});
