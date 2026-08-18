/* eslint-disable import/no-extraneous-dependencies */
import { defineConfig } from 'electron-vite';
import path, { resolve } from 'path';
import vue from '@vitejs/plugin-vue';
import svgLoader from 'vite-svg-loader';
import { fileURLToPath } from 'url';
import util from 'util';
import { exec } from 'child_process';
import { readFileSync } from 'fs';

// Read rather than imported: JSON import attributes are still new enough that
// the syntax itself fails on older Node, and a config that will not parse
// takes the whole build with it.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const asyncExec = util.promisify(exec);

/**
 * Runs a command and hands back its output, trimmed.
 *
 * Trimmed because git ends every line with a newline, and these end up both as
 * screen text and inside URLs -- an untrimmed branch made a release link that
 * pointed at `tree/master%0A`.
 *
 * @param {String} command shell command
 * @returns {Promise<String>} stdout, or an empty string if it failed
 */
async function readCommand(command) {
  try {
    const execData = await asyncExec(command);
    return (execData.stdout || '').trim();
  } catch (err) {
    return '';
  }
}

async function prepareVersioningEnv() {
  // package.json first, git second. The tag lookup fails on any checkout whose
  // history carries no tag -- `git describe` refuses rather than guessing --
  // and a version of '' left the splash reading "no-version-data". package.json
  // is also what electron-builder names the installer after, so the splash and
  // the file on disk now agree by construction.
  const described = await readCommand('git describe --tags --abbrev=0');
  process.env.VITE_APP_VERSION = described || pkg.version || '';

  // Dated from the tag when there is one, otherwise from the last commit --
  // which is the honest answer for a build made from an untagged checkout.
  process.env.VITE_APP_BUILD_DATE = await readCommand(
    `git log -1 --format=%ai ${described}`.trim(),
  );

  process.env.VITE_APP_BRANCH = await readCommand('git rev-parse --abbrev-ref HEAD');
}

const filename = fileURLToPath(import.meta.url);
const pathSegments = path.dirname(filename);

export default defineConfig(async ({ command } = {}) => {
  // Assets are served over the custom `static://` protocol only in packaged
  // builds. In dev the renderer is served by the Vite dev server, so static
  // assets are fetched over http from `public/` (VITE_STATIC_URL stays empty).
  process.env.VITE_STATIC_URL = command === 'build' ? 'static:/' : '';
  await prepareVersioningEnv();
  return {
    root: './',
    plugins: [
      vue(),
      svgLoader(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(pathSegments, './src'),
        '@root': path.resolve(pathSegments, './'),
      },
      extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
    },
    main: {
      plugins: [
        vue(),
        svgLoader(),
      ],
      resolve: {
        alias: {
          '@': path.resolve(pathSegments, './src'),
          '@root': path.resolve(pathSegments, './'),
        },
        extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
      },
      root: '.',
      build: {
        publicDir: resolve(__dirname, 'public'),
        lib: {
          entry: './src/electron/main.js',
        },
        rollupOptions: {
          external: [
            'bufferutil',
            'utf-8-validate',
          ],
        },
      },
    },
    preload: {
      build: {
        publicDir: resolve(__dirname, 'public'),
        lib: {
          entry: './src/electron/preload.js',
        },
      },
    },
    renderer: {
      plugins: [
        vue(),
        svgLoader(),
      ],
      resolve: {
        alias: {
          '@': path.resolve(pathSegments, './src'),
          '@root': path.resolve(pathSegments, './'),
        },
        extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
      },
      root: '.',
      build: {
        publicDir: resolve(__dirname, 'public'),
        rollupOptions: {
          input: {
            index: './index.html',
          },
        },
      },
    },
  };
});
