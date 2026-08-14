/* eslint-disable no-console */
/**
 * Art-Net ingest benchmark.
 *
 * Measures what it actually costs to push inbound DMX frames through the
 * existing model layer, at a scale the app was never built for (72 universes).
 *
 * The path under test is the real one, not a reimplementation:
 *   universe.DMX512Data = data   (universe.model.js:135)
 *     -> loops all 512 channels, unconditionally
 *     -> fixture.setChannel()    (fixture.model.js:643)
 *       -> channel.getCapability() linear scan, then 3D model writes
 *
 * Diffing (universe.diffInput) is measured on and off, at three change rates:
 * the 53.3% observed live from MadMapper, plus 100% and 0% as bounds. The
 * 100% case is what proves diffing costs nothing when there is nothing to
 * skip; the 0% case is the ceiling.
 *
 * Usage:
 *   node bench/dist/ingest.bench.mjs [--universes=72] [--frames=300]
 *                                    [--hz=40] [--change-rate=53.3]
 */
import fs from 'fs';
import path from 'path';
import Universe from '@/models/DMX/universe.model';
import Fixture from '@/models/DMX/fixture.model';

const arg = (key, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const UNIVERSES = Number(arg('universes', 72));
const FRAMES = Number(arg('frames', 200));
const TARGET_HZ = Number(arg('hz', 44));
// Moving Head is the only category fixture.model.js:734 will instantiate, so
// it is also the only thing that can be benchmarked through the real path.
const PROFILE = arg('profile', 'public/fixtures/5star-systems/spica-250m.json');
const MODE = arg('mode', '16bit');
/** Fixtures per universe; defaults to filling all 512 channels. */
const FIXTURES = arg('fixtures', null);
/** Percentage of channels that change between frames; 53.3% measured live. */
const CHANGE_RATE = Number(arg('change-rate', 53.3));

const DMX_LEN = 512;

/**
 * Replaces the three.js MovingHead instance with a plain object of the same
 * shape.
 *
 * The renderer's GPU-side work (buffer attribute uploads, matrix updates)
 * cannot run headless and is out of scope here: the question is what the DMX
 * model layer costs, not what drawing costs. Every measurement below is
 * therefore a LOWER BOUND on the real per-frame cost.
 */
Fixture.prototype.prepare3DModelInstance = function stub3DModel() {
  this._3DModel = {
    colorPreset: null,
    colorIntensity: null,
    colorWheelSlot: 0,
    goboWheelSlot: 0,
    intensity: 0,
    pan: 0,
    tilt: 0,
    panFine: 0,
    tiltFine: 0,
    shutter: 1,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
};

/** Monotonic wall-clock in ms. */
const now = () => Number(process.hrtime.bigint()) / 1e6;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const fmt = (n) => n.toFixed(3).padStart(9);

/**
 * Builds `count` universes, each patched to fill all 512 channels.
 */
function buildRig(count) {
  const ofl = JSON.parse(fs.readFileSync(path.resolve(PROFILE), 'utf8'));
  const mode = ofl.modes.find((m) => m.name === MODE) || ofl.modes[0];
  const chCount = mode.channels.length;
  const perUniverse = FIXTURES ? Number(FIXTURES) : Math.floor(DMX_LEN / chCount);

  const universes = [];
  const t0 = now();
  for (let u = 0; u < count; u += 1) {
    const universe = new Universe({ id: u, name: `U${u}` });
    for (let f = 0; f < perUniverse; f += 1) {
      const fixture = new Fixture({
        OFLData: ofl,
        id: f,
        universe: u,
        chStart: f * chCount,
        mode: mode.name,
        manufacturer: path.basename(path.dirname(PROFILE)),
        model: path.basename(PROFILE, '.json'),
        name: `fx${f}`,
      });
      universe.patchFixture(fixture);
    }
    universes.push(universe);
    if (process.stdout.isTTY) {
      process.stdout.write(`  patched ${u + 1}/${count} universes\r`);
    }
  }
  if (process.stdout.isTTY) process.stdout.write(`${' '.repeat(48)}\r`);
  return {
    universes, buildMs: now() - t0, chCount, perUniverse, modeName: mode.name,
  };
}

/**
 * Frames where a given fraction of channels changes between successive frames.
 *
 * The live probe measured 53.3% against real MadMapper output on fast-moving
 * content, which is the figure that matters; 100% and 0% bracket it.
 */
function makeFrames(frameCount, changeRate) {
  const frames = [];
  const current = new Uint8Array(DMX_LEN);
  for (let i = 0; i < DMX_LEN; i += 1) {
    current[i] = (i * 37) & 0xff;
  }

  for (let f = 0; f < frameCount; f += 1) {
    for (let i = 0; i < DMX_LEN; i += 1) {
      if (Math.random() < changeRate) {
        // Step by a non-zero amount so the value genuinely differs.
        current[i] = (current[i] + 1 + Math.floor(Math.random() * 254)) & 0xff;
      }
    }
    frames.push(current.slice());
  }
  return frames;
}

/**
 * Drives the real shipped path. Diffing is whatever the universe is configured
 * to do, so this measures the actual model code rather than a copy of it.
 */
function write(universe, data) {
  universe.DMX512Data = data;
}

/** Applies a diffInput setting across the whole rig. */
function setDiffing(universes, enabled) {
  universes.forEach((universe) => {
    universe.diffInput = enabled;
  });
}

/**
 * Times one full pass over every universe per frame. A "frame" here is a
 * complete refresh of the whole rig, i.e. the work that has to fit inside
 * 1/hz seconds.
 */
function run(label, universes, frames, diffing) {
  const durations = [];
  setDiffing(universes, diffing);

  // Warm-up, so JIT compilation is not attributed to the measurement, and so
  // the diffing shadow is primed before the first timed frame.
  for (let f = 0; f < Math.min(10, frames.length); f += 1) {
    for (let u = 0; u < universes.length; u += 1) {
      write(universes[u], frames[f % frames.length]);
    }
  }

  for (let f = 0; f < frames.length; f += 1) {
    const frame = frames[f];
    const t0 = now();
    for (let u = 0; u < universes.length; u += 1) {
      write(universes[u], frame);
    }
    durations.push(now() - t0);
  }

  durations.sort((a, b) => a - b);
  const total = durations.reduce((a, b) => a + b, 0);
  return {
    label,
    mean: total / durations.length,
    p50: pct(durations, 0.5),
    p95: pct(durations, 0.95),
    max: durations[durations.length - 1],
  };
}

/** Cost of moving one frame across the Electron IPC boundary. */
function measureIpcClone(frames) {
  const payload = { universe: 0, data: frames[0] };
  const iterations = 20000;
  const t0 = now();
  for (let i = 0; i < iterations; i += 1) {
    structuredClone(payload);
  }
  return (now() - t0) / iterations;
}

function main() {
  const budgetMs = 1000 / TARGET_HZ;

  console.log('Art-Net ingest benchmark');
  console.log('========================');
  console.log(`universes        ${UNIVERSES}`);
  console.log(`frames measured  ${FRAMES}`);
  console.log(`target rate      ${TARGET_HZ} Hz -> ${budgetMs.toFixed(2)} ms budget per full refresh`);
  console.log('');

  console.log('Building rig...');
  const {
    universes, buildMs, chCount, perUniverse, modeName,
  } = buildRig(UNIVERSES);
  console.log(`  profile        ${PROFILE} [${modeName}, ${chCount}ch]`);
  console.log(`  per universe   ${perUniverse} fixtures (${perUniverse * chCount} of ${DMX_LEN} channels)`);
  console.log(`  total          ${UNIVERSES * perUniverse} fixtures in ${(buildMs / 1000).toFixed(1)}s`);
  console.log('');

  const real = makeFrames(FRAMES, CHANGE_RATE / 100);
  const worst = makeFrames(FRAMES, 1);
  const held = makeFrames(FRAMES, 0);

  const results = [
    run(`off   @${CHANGE_RATE}%`, universes, real, false),
    run(`on    @${CHANGE_RATE}%`, universes, real, true),
    run('off   @100%', universes, worst, false),
    run('on    @100%', universes, worst, true),
    run('off   @0%', universes, held, false),
    run('on    @0%', universes, held, true),
  ];

  console.log('Per full refresh of all universes (ms)');
  console.log('  diffing / change      mean       p50       p95       max     max Hz');
  console.log(`  ${'-'.repeat(68)}`);
  results.forEach((r) => {
    const maxHz = r.p95 > 0 ? 1000 / r.p95 : Infinity;
    const hz = Number.isFinite(maxHz) ? maxHz.toFixed(1).padStart(9) : '      inf';
    console.log(`  ${r.label.padEnd(18)}${fmt(r.mean)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.max)} ${hz}`);
  });
  console.log('');

  const cloneMs = measureIpcClone(real);
  const clonesPerSec = UNIVERSES * TARGET_HZ;
  console.log('IPC transfer (structuredClone of one 512-byte frame)');
  console.log(`  per frame        ${cloneMs.toFixed(4)} ms`);
  console.log(`  at ${clonesPerSec}/s        ${(cloneMs * clonesPerSec).toFixed(1)} ms/s `
    + `(${((cloneMs * clonesPerSec) / 10).toFixed(2)}% of one core)`);
  console.log('');

  const [off, on] = results;
  console.log('Verdict');
  console.log(`  ${'-'.repeat(68)}`);
  console.log(`  at the measured ${CHANGE_RATE}% change rate, diffing takes ingest from `
    + `${off.p95.toFixed(2)} ms to ${on.p95.toFixed(2)} ms p95`);
  console.log(`  speedup:         ${(off.p95 / Math.max(on.p95, 1e-9)).toFixed(2)}x`);
  console.log(`  budget at ${TARGET_HZ} Hz: ${budgetMs.toFixed(2)} ms  ->  `
    + `${((off.p95 / budgetMs) * 100).toFixed(0)}% used without diffing, `
    + `${((on.p95 / budgetMs) * 100).toFixed(0)}% with`);
  console.log('');
}

main();
