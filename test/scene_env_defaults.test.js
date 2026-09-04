/* eslint-disable no-console */
/**
 * The room's haze has one set of defaults, and one place percentages convert.
 *
 * There used to be three sets -- `SceneEnv`'s constructor said zero,
 * `visualizer.js` said a hundred, `preferences.js` said seventy -- and which
 * one you saw depended on the order the scene was built in. The debug panel,
 * built before the stored settings were applied, read the constructor's zeros
 * and displayed them for the rest of the session.
 *
 * So: the room comes up at the preference defaults with nothing loaded, and
 * `adopt` is the only thing that divides by a hundred.
 *
 * Usage:
 *   npm test
 */
import SceneEnv from '@/plugins/visualizer/scene_env';
import Preferences from '@/plugins/visualizer/preferences';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

console.log('\n-- built at the defaults, not at zero --');
{
  const { DEFAULTS } = Preferences;
  check('turbulence', SceneEnv.hazeTurbulence, DEFAULTS.globalFoggingTurbulences / 100);
  check('and it is the 70-odd Paul expects', SceneEnv.hazeTurbulence > 0.5, true);
  check('density', SceneEnv.hazeDensity, DEFAULTS.globalFoggingDensity / 100);
  check('scale, in metres', SceneEnv.hazeScale, DEFAULTS.globalFoggingScale);
  check('haze is on', SceneEnv.hazeEnabled, !!DEFAULTS.globalFoggingState);
  // Nothing has been read from disk at this point: this is what a renderer or
  // a panel sees if it is built before the preference file arrives.
  check('so there is haze to draw', SceneEnv.hazeAmount > 0, true);
}

console.log('\n-- adopting stored settings --');
{
  SceneEnv.adopt({
    globalFoggingState: 1,
    globalFoggingDensity: 59,
    globalFoggingTurbulences: 74,
    globalFoggingScale: 13.1,
  });
  check('percentages become fractions', SceneEnv.hazeTurbulence, 0.74);
  check('density too', SceneEnv.hazeDensity, 0.59);
  check('metres stay metres', SceneEnv.hazeScale, 13.1);
}

console.log('\n-- a setting the file does not carry --');
{
  SceneEnv.adopt({ globalFoggingDensity: 20 });
  check('takes its default', SceneEnv.hazeTurbulence,
    Preferences.DEFAULTS.globalFoggingTurbulences / 100);
  check('rather than zero', SceneEnv.hazeTurbulence > 0, true);
  check('and the named one is used', SceneEnv.hazeDensity, 0.2);
}

console.log('\n-- the house lights take the room air, not the beams --');
{
  SceneEnv.adopt();
  SceneEnv.houseLights = true;
  check('room air is clear under work light', SceneEnv.roomHaze, 0);
  check('but a beam still scatters', SceneEnv.hazeAmount > 0, true);
  SceneEnv.houseLights = false;
  check('and comes back with the house down', SceneEnv.roomHaze, SceneEnv.hazeAmount);
}

console.log('\n-- switched off is off, whatever the density --');
{
  SceneEnv.hazeEnabled = false;
  check('no haze', SceneEnv.hazeAmount, 0);
  check('density is remembered', SceneEnv.hazeDensity > 0, true);
  SceneEnv.hazeEnabled = true;
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
