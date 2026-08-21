/**
 * @file Rendering cost readout.
 *
 * Frame rate alone is close to useless on a fast card: with vsync the GPU
 * finishes early and idles, so the number stays pinned at the refresh rate
 * until the moment it collapses. Two things here address that.
 *
 * GPU time is read with a timer query, which measures how long the card
 * actually spent on the frame rather than how long until the next vsync.
 *
 * `passes` renders the scene several times per frame. The reported cost is
 * divided by that count, so a scene using 15% of the budget can be measured
 * accurately by making it use 90%.
 */

import DMXStore from './dmx_store';

/** Rolling window for the averages, in frames. */
const WINDOW = 60;

const state = {
  passes: 1,
  cpuSamples: [],
  gpuSamples: [],
  frames: 0,
  lastReport: 0,
  lastLog: 0,
  fps: 0,
  element: null,
  /** Whether the readout should be on screen once it exists. */
  visible: true,
  gl: null,
  ext: null,
  // Timer query results are not ready in the frame that issues them, so each
  // one is parked here and polled on later frames. Reading it back immediately
  // simply never succeeds.
  pending: [],
  active: null,
  cpuStart: 0,
  renderer: null,
};

const average = (samples) => (
  samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0
);

function push(samples, value) {
  samples.push(value);
  if (samples.length > WINDOW) samples.shift();
}

/**
 * @param {Object} host element the overlay is positioned within
 * @returns {Object} the overlay element
 */
function buildElement(host) {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'top:58px',
    'left:8px',
    'z-index:100',
    'padding:8px 10px',
    'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'color:#d8dee9',
    'background:rgba(16,18,22,0.82)',
    'border:1px solid rgba(255,255,255,0.10)',
    'border-radius:4px',
    'white-space:pre',
    'pointer-events:none',
  ].join(';');
  // Anchored to the canvas's own container rather than the document, so it
  // sits inside the 3D viewport instead of over the panels beside it.
  const parent = host || document.body;
  if (parent !== document.body && getComputedStyle(parent).position === 'static') {
    // Absolute positioning needs a positioned ancestor to measure against.
    parent.style.position = 'relative';
  }
  parent.appendChild(el);
  return el;
}

/**
 * @param {Object} renderer THREE.WebGLRenderer
 */
function init(renderer) {
  state.renderer = renderer;
  // Counters reset on every internal render call by default, so a composer
  // chain leaves only its final fullscreen pass behind. Reset once per frame
  // instead, and the totals cover every pass.
  renderer.info.autoReset = false;
  state.element = buildElement(renderer.domElement.parentElement);
  state.element.style.display = state.visible ? '' : 'none';
  state.gl = renderer.getContext();
  // Often unavailable: browsers gate it because precise GPU timing is a
  // fingerprinting and side-channel vector. CPU time and draw counts still work.
  state.ext = state.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  // eslint-disable-next-line no-console
  console.log('[perf] GPU timer query:', state.ext ? 'available' : 'unavailable');
  state.lastReport = performance.now();
}

/** Called immediately before rendering. */
function begin() {
  if (state.renderer) state.renderer.info.reset();
  if (state.ext && !state.active) {
    const query = state.gl.createQuery();
    state.gl.beginQuery(state.ext.TIME_ELAPSED_EXT, query);
    // Passes is recorded alongside: this query measures the load in force now,
    // which may not be the load in force when the result arrives.
    state.active = { query, passes: state.passes };
  }
  state.cpuStart = performance.now();
}

/** Drains whichever parked timer queries have completed. */
function collectGpuTime() {
  if (!state.ext) return;
  const { gl } = state;

  while (state.pending.length) {
    const oldest = state.pending[0];
    if (!gl.getQueryParameter(oldest.query, gl.QUERY_RESULT_AVAILABLE)) break;

    const disjoint = gl.getParameter(state.ext.GPU_DISJOINT_EXT);
    const nanoseconds = gl.getQueryParameter(oldest.query, gl.QUERY_RESULT);
    gl.deleteQuery(oldest.query);
    state.pending.shift();

    // A disjoint means the GPU was interrupted and the timing is meaningless.
    if (!disjoint) push(state.gpuSamples, nanoseconds / 1e6 / oldest.passes);
  }

  // Should never grow, but a stalled query must not leak frames indefinitely.
  while (state.pending.length > 8) {
    gl.deleteQuery(state.pending.shift().query);
  }
}

/** Called immediately after rendering. */
function end() {
  push(state.cpuSamples, (performance.now() - state.cpuStart) / state.passes);

  if (state.ext && state.active) {
    state.gl.endQuery(state.ext.TIME_ELAPSED_EXT);
    state.pending.push(state.active);
    state.active = null;
  }
  collectGpuTime();

  state.frames += 1;
  const now = performance.now();
  const elapsed = now - state.lastReport;
  if (elapsed < 500) return;

  state.fps = (state.frames * 1000) / elapsed;
  state.frames = 0;
  state.lastReport = now;

  const info = state.renderer ? state.renderer.info : null;
  let gpu;
  if (state.gpuSamples.length) {
    gpu = `${average(state.gpuSamples).toFixed(2)} ms`;
  } else {
    gpu = state.ext ? 'measuring...' : 'unsupported';
  }

  const dmx = DMXStore.stats();

  // Also emitted to the console every few seconds, so the numbers can be read
  // from a log rather than only off the screen.
  if (now - state.lastLog > 3000) {
    state.lastLog = now;
    // eslint-disable-next-line no-console
    console.log('[perf]', JSON.stringify({
      fps: Number(state.fps.toFixed(1)),
      gpuMs: state.gpuSamples.length ? Number(average(state.gpuSamples).toFixed(3)) : null,
      cpuMs: Number(average(state.cpuSamples).toFixed(3)),
      passes: state.passes,
      draws: info ? info.render.calls : null,
      triangles: info ? info.render.triangles : null,
      dmxRows: dmx.rows,
      dmxMBs: Number((dmx.bytesPerSecond / 1048576).toFixed(2)),
      dmxPartial: dmx.partial,
    }));
  }

  state.element.textContent = [
    `fps        ${state.fps.toFixed(1)}`,
    `gpu        ${gpu}`,
    `cpu        ${average(state.cpuSamples).toFixed(2)} ms`,
    `passes     ${state.passes}`,
    `draws      ${info ? info.render.calls : '-'}`,
    `triangles  ${info ? info.render.triangles.toLocaleString() : '-'}`,
    `textures   ${info ? info.memory.textures : '-'}`,
    // The DMX upload is the one per-frame cost that does not follow from
    // what is on screen: it follows from how many universes arrived.
    // Reported here because a rig that suddenly costs megabytes a second
    // is invisible in every other number on this list.
    `dmx        ${dmx.rows} rows  ${(dmx.bytesPerSecond / 1048576).toFixed(1)} MB/s${dmx.partial ? '' : ' (whole)'}`,
  ].join('\n');
}

/**
 * Renders the scene `passes` times per frame so its cost can be measured while
 * there is still headroom. Reported timings are per pass.
 *
 * @param {Number} count
 */
function setPasses(count) {
  state.passes = Math.max(1, Math.round(count));
  state.cpuSamples.length = 0;
  state.gpuSamples.length = 0;
}

/**
 * Shows or hides the readout.
 *
 * The measuring carries on either way: the cost of reading a timer query is
 * nothing beside the frame it measures, and stopping would mean the numbers
 * were cold every time the panel came back.
 *
 * @param {Boolean} visible
 */
function setVisible(visible) {
  state.visible = !!visible;
  // Recorded whether or not the element exists yet: the preference is read
  // while the scene is built and the overlay is created with the renderer, and
  // the order between those is not this module's business.
  if (state.element) state.element.style.display = state.visible ? '' : 'none';
}

/** @returns {Number} how many times the scene is drawn per frame */
function getPasses() {
  return state.passes;
}

export default {
  init, begin, end, setPasses, getPasses, setVisible,
};
