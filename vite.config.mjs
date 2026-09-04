/* eslint-disable import/no-extraneous-dependencies */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import svgLoader from 'vite-svg-loader';
import { fileURLToPath } from 'url';
import path from 'path';
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
  // **package.json decides the version, not the nearest git tag.**
  //
  // It used to be the tag, and the two drifted apart for three releases. The
  // release path creates the tag with `gh release create`, which makes it on
  // GitHub -- nothing brings it back to the working copy unless someone
  // remembers `git fetch --tags`. So the newest local version tag sat at
  // alpha.5 while package.json said alpha.8, and the About box reported a
  // build three releases old.
  //
  // Worse, electron-builder names the installer from `${version}` in
  // package.json. So the file on disk said alpha.8 and the splash inside it
  // said alpha.5 -- one fact with two sources, disagreeing silently. Reading
  // both from package.json makes them agree by construction, and it is also
  // the first thing a release bumps, so it cannot lag.
  process.env.VITE_APP_VERSION = pkg.version || '';

  // The nearest version-shaped tag, still read -- not to name the build, but to
  // date it and to notice when it disagrees.
  //
  // Only tags that look like a version. Without the match, `git describe` takes
  // the nearest tag of *any* shape, and a repository picks up tags that are not
  // releases: a restore point before a refactor, a bookmark, whatever somebody
  // needed a name for. One of those sat between HEAD and the last release and
  // the splash duly reported the build as "pre-scene-item-refactor".
  //
  // The glob is in double quotes deliberately. This runs through `exec`, which
  // is cmd.exe on Windows, and cmd.exe does not treat a single quote as a quote
  // at all -- git would be handed the quotes as part of the pattern and match
  // nothing. Double quotes are honoured by both cmd.exe and sh.
  const described = await readCommand('git describe --tags --abbrev=0 --match "[0-9]*"');
  if (described && described !== pkg.version) {
    // Not fatal: building from an untagged checkout is normal, and the tag for
    // a release is often made after the build. Said out loud because the one
    // time it matters -- a tag that has moved past package.json -- means a
    // release was cut without bumping it.
    console.log(`[version] package.json ${pkg.version}, nearest tag ${described}`);
  }

  // Dated from the tag when there is one, otherwise from the last commit --
  // which is the honest answer for a build made from an untagged checkout.
  process.env.VITE_APP_BUILD_DATE = await readCommand(
    `git log -1 --format=%ai ${described}`.trim(),
  );

  process.env.VITE_APP_BRANCH = await readCommand('git rev-parse --abbrev-ref HEAD');
}

const filename = fileURLToPath(import.meta.url);
const pathSegments = path.dirname(filename);

export default defineConfig(async () => {
  try {
    await prepareVersioningEnv();
    return {
      plugins: [
        vue(),
        svgLoader(),
      ],
      resolve: {
        alias: {
          '@': path.resolve(pathSegments, './src'),
          '@root': path.resolve(pathSegments, './'),
        },
        extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue', '*?raw'],
      },
    };
  } catch (err) {
    return err;
  }
});
