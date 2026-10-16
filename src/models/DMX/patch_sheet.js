import * as THREE from 'three';
import PatchSingleton, { DMX_UNIVERSE_LENGTH } from './patch.model';
import { SHOW_SCOPE } from './definition_store';
import { SCENE_ITEM_KINDS, kindOf } from './scene_item';
import MovingHead from '../../plugins/visualizer/moving_head';
import SceneObjects from '../../plugins/visualizer/scene_objects';
import MeasureTool, { MEASURE_MODES, detailsOf } from '../../plugins/visualizer/measure_tool';
import LineDrawing from '../../plugins/visualizer/line_drawing';
import logoUrl from '../../assets/images/beam_logo.png';

/**
 * @file The patch sheet: a PDF for the crew that sets each fixture's mode and
 * address, with a plan and elevations of the rig numbered to match. The
 * objects in each view are a hidden-line drawing; fixtures, arrows and
 * measurements are drawn over it as vectors.
 *
 * Universes are given twice, because Art-Net counts from 0 and sACN from 1;
 * Beam's universe is the Art-Net one.
 *
 * A mover's arrow is where its beam swings when tilt rises above centre with
 * pan at centre. A profile does not say which side of the base carries the
 * display, so the arrow is the one direction the crew can check on the unit.
 */

/** Where the sheet sends a reader who wants to know what made it. */
export const BEAM_URL = 'https://beatline.xyz/beam/';

/** Tilt applied when finding which way a head swings, in degrees. */
const TILT_PROBE_DEG = 30;

/**
 * Printable area of each paper size in landscape, in millimetres: the sheet
 * less margins of 12 mm on three sides and 14 mm at the foot for the footer.
 */
export const PAPER = {
  A4: { css: 'A4', width: 273, height: 184 },
  Letter: { css: 'letter', width: 255.4, height: 189.9 },
};

/** What the sheet prints when nothing else is asked for. */
export const PATCH_SHEET_DEFAULTS = Object.freeze({
  /** The project notes from Project Details. */
  notes: true,
  /** The bulleted notes on universes, modes and positions. */
  instructions: true,
  patchList: true,
  fixtureTypes: true,
  /** The views drawn, each on its own page. */
  viewTop: true,
  viewFront: false,
  viewBack: false,
  viewLeft: false,
  viewRight: false,
  /** Measurements, in the views and as a table. */
  measurements: true,
  /** Fixtures that are not patched, in the list and the views. */
  unpatched: true,
  moverArrows: true,
  grid: true,
  paper: 'A4',
});

/**
 * Plot height in CSS pixels at 96 dpi; the width follows the paper. Every
 * view has a page of its own.
 */
const PLOT_HEIGHT = 540;
/** Room beside the plot for the stage-side labels, in CSS pixels. */
const PLOT_SIDES = 42;
const PX_PER_MM = 96 / 25.4;
/** Image pixels per CSS pixel in a view's drawing: about 190 dpi on paper. */
const IMAGE_SCALE = 2;
/** How far behind a surface a fixture must be to count as hidden, in metres. */
const HIDDEN_MARGIN_M = 0.15;

const AUDIENCE = 'DOWNSTAGE &nbsp;&middot;&nbsp; AUDIENCE';

/**
 * The views the sheet can draw. `forward` is the direction looked in and `up`
 * is up on the page; across the page is forward x up. Edge labels are the
 * stage directions at each side of the drawing. The audience is at -y.
 */
export const VIEWS = {
  top: {
    option: 'viewTop',
    title: 'Plan',
    seen: 'Seen from above.',
    forward: [0, 0, -1],
    up: [0, 1, 0],
    labels: {
      top: 'UPSTAGE', bottom: AUDIENCE, left: 'STAGE RIGHT', right: 'STAGE LEFT',
    },
  },
  front: {
    option: 'viewFront',
    title: 'Front elevation',
    seen: 'Seen from the audience.',
    forward: [0, 1, 0],
    up: [0, 0, 1],
    labels: {
      top: '', bottom: '', left: 'STAGE RIGHT', right: 'STAGE LEFT',
    },
  },
  back: {
    option: 'viewBack',
    title: 'Back elevation',
    seen: 'Seen from upstage, looking at the audience.',
    forward: [0, -1, 0],
    up: [0, 0, 1],
    labels: {
      top: '', bottom: '', left: 'STAGE LEFT', right: 'STAGE RIGHT',
    },
  },
  left: {
    option: 'viewLeft',
    title: 'Side elevation from stage left',
    seen: 'Seen from stage left.',
    forward: [-1, 0, 0],
    up: [0, 0, 1],
    labels: {
      top: '', bottom: '', left: AUDIENCE, right: 'UPSTAGE',
    },
  },
  right: {
    option: 'viewRight',
    title: 'Side elevation from stage right',
    seen: 'Seen from stage right.',
    forward: [1, 0, 0],
    up: [0, 0, 1],
    labels: {
      top: '', bottom: '', left: 'UPSTAGE', right: AUDIENCE,
    },
  },
};

/**
 * @param {Object} view an entry of `VIEWS`
 * @returns {Function} `[x, y, z]` to `[u, v, d]`: metres across the page, up
 *   it, and into it
 */
export function projector(view) {
  const { forward: f, up } = view;
  const across = [
    f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0],
  ];
  const dot = (a, p) => a[0] * p[0] + a[1] * p[1] + a[2] * p[2];
  return (p) => [dot(across, p), dot(up, p), dot(f, p)];
}

/**
 * @param {Object} [options]
 * @returns {Object} every option, defaults filled in
 */
function withDefaults(options) {
  const merged = { ...PATCH_SHEET_DEFAULTS, ...(options || {}) };
  if (!PAPER[merged.paper]) merged.paper = PATCH_SHEET_DEFAULTS.paper;
  return merged;
}

const scratchBox = new THREE.Box3();
const scratchVector = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();

/**
 * @param {String} text
 * @returns {String} safe inside HTML text and attributes
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convex hull of 2D points, counter-clockwise (monotone chain).
 *
 * @param {Array<Array<Number>>} points `[x, y]` pairs
 * @returns {Array<Array<Number>>}
 */
export function hull(points) {
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (sorted.length < 3) return sorted;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const turnsRight = (chain, p) => chain.length >= 2
    && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0;
  const lower = [];
  sorted.forEach((p) => {
    while (turnsRight(lower, p)) lower.pop();
    lower.push(p);
  });
  const upper = [];
  sorted.slice().reverse().forEach((p) => {
    while (turnsRight(upper, p)) upper.pop();
    upper.push(p);
  });
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * The eight corners of a local box under a matrix, in world space.
 *
 * @param {THREE.Box3} box
 * @param {THREE.Matrix4} matrix
 * @returns {Array<Array<Number>>} `[x, y, z]` triples
 */
function worldCorners(box, matrix) {
  const corners = [];
  [box.min.x, box.max.x].forEach((x) => [box.min.y, box.max.y].forEach((y) => [box.min.z, box.max.z]
    .forEach((z) => {
      scratchVector.set(x, y, z).applyMatrix4(matrix);
      corners.push([scratchVector.x, scratchVector.y, scratchVector.z]);
    })));
  return corners;
}

/**
 * Corners of a renderer handle's body: at rest where the handle knows it,
 * otherwise its world bounding box.
 *
 * @param {Object} model a fixture's or object's `_3DModel`
 * @returns {Array<Array<Number>>|null}
 */
function bodyCorners(model) {
  if (!model) return null;
  if (model._restBounds && !model._restBounds.isEmpty() && model._dummy) {
    model._dummy.updateMatrixWorld();
    return worldCorners(model._restBounds, model._dummy.matrixWorld);
  }
  if (!model.expandBounds) return null;
  scratchBox.makeEmpty();
  model.expandBounds(scratchBox);
  if (scratchBox.isEmpty()) return null;
  return worldCorners(scratchBox, new THREE.Matrix4());
}

/**
 * Corners of a placed object, from its model's own bounds so a turned truss
 * is turned.
 *
 * @param {Object} object a scene object
 * @returns {Array<Array<Number>>|null}
 */
function objectCorners(object) {
  const local = SceneObjects.boundsOf(object.renderKey);
  if (!local || local.isEmpty() || !object.transformNode) return bodyCorners(object._3DModel);
  object.transformNode.updateMatrixWorld();
  const { x, y, z } = object._scale || { x: 1, y: 1, z: 1 };
  const matrix = object.transformNode.matrixWorld.clone()
    .multiply(new THREE.Matrix4().makeScale(x, y, z));
  return worldCorners(local, matrix);
}

/**
 * How the fixture's base is mounted, from where its up axis points.
 *
 * @param {Object} model the fixture's `_3DModel`
 * @returns {String} `Hung`, `Standing`, `Sideways`, or empty when unknown
 */
function mountOf(model) {
  if (!model || !model._dummy) return '';
  model._dummy.updateMatrixWorld();
  model._dummy.getWorldQuaternion(scratchQuaternion);
  const up = scratchVector.set(0, 0, 1).applyQuaternion(scratchQuaternion).z;
  if (up < -0.7) return 'Hung';
  if (up > 0.7) return 'Standing';
  return 'Sideways';
}

/**
 * Which way a mover's beam swings across the floor when tilt rises from
 * centre with pan at centre, as a plan angle in degrees anticlockwise from +X.
 *
 * Poses the yoke and head, reads the beam, and puts them back within the same
 * call, so no frame is drawn with the probe pose.
 *
 * @param {Object} model the fixture's `_3DModel`
 * @param {Boolean} [rising] whether the head's tilt angle grows with DMX
 * @returns {Number|null} null for anything without a yoke
 */
export function panCentreBearing(model, rising = true) {
  if (!(model instanceof MovingHead) || !model._yokeDummy || !model._headDummy) return null;
  const yoke = model._yokeDummy.rotation.z;
  const head = model._headDummy.rotation.x;
  const beamAt = (tilt) => {
    model._yokeDummy.rotation.z = 0;
    model._headDummy.rotation.x = tilt;
    model._dummy.updateMatrixWorld(true);
    return model._beamDummy.getWorldDirection(new THREE.Vector3());
  };
  try {
    const centre = beamAt(0);
    const raised = beamAt(THREE.MathUtils.degToRad(rising ? TILT_PROBE_DEG : -TILT_PROBE_DEG));
    const swing = raised.sub(centre);
    if (Math.hypot(swing.x, swing.y) < 1e-4) return null;
    return THREE.MathUtils.radToDeg(Math.atan2(swing.y, swing.x));
  } finally {
    model._yokeDummy.rotation.z = yoke;
    model._headDummy.rotation.x = head;
    model._dummy.updateMatrixWorld(true);
  }
}

/**
 * Whether the profile's tilt angle grows as its DMX value does. A profile
 * that states it falling turns the head the other way for the same DMX.
 *
 * @param {Object} fixture
 * @returns {Boolean} true when the profile does not say
 */
export function tiltRises(fixture) {
  const engine = fixture._engine;
  if (!engine) return true;
  let rising = true;
  engine.channels.some((channel) => channel.functions.some((f) => {
    if (f.attribute !== 'Tilt' || f.ofl) return false;
    if (f.physicalFrom == null || f.physicalTo == null) return false;
    if (f.physicalFrom === f.physicalTo) return false;
    rising = (f.physicalTo - f.physicalFrom) * (f.dmxTo - f.dmxFrom) > 0;
    return true;
  }));
  return rising;
}

/**
 * Manufacturer and model as printed on the unit. A definition made in this
 * show has no manufacturer yet, so only its name is given.
 *
 * @param {Object} fixture
 * @returns {String}
 */
export function typeName(fixture) {
  const name = (fixture.OFLData && fixture.OFLData.name) || fixture.model || '';
  const manufacturer = (fixture.fixtureType && fixture.fixtureType.manufacturer)
    || fixture.manufacturer;
  if (!manufacturer || manufacturer === SHOW_SCOPE) return name;
  return `${manufacturer} ${name}`;
}

/**
 * Universe and channel of an absolute zero-based address.
 *
 * @param {Number} address
 * @returns {{ universe: Number, channel: Number }} channel counted from 1
 */
export function splitAddress(address) {
  return {
    universe: Math.floor(address / DMX_UNIVERSE_LENGTH),
    channel: (address % DMX_UNIVERSE_LENGTH) + 1,
  };
}

/**
 * The fixtures and objects among scene items, counting the members of
 * structures and groups.
 *
 * @param {Array} items scene items, as the export popup is given them
 * @returns {{ fixtures: Set, objects: Set }}
 */
export function itemsScope(items) {
  const scope = { fixtures: new Set(), objects: new Set() };
  const add = (item) => {
    const kind = kindOf(item);
    if (kind === SCENE_ITEM_KINDS.FIXTURE) scope.fixtures.add(item);
    else if (kind === SCENE_ITEM_KINDS.OBJECT) scope.objects.add(item);
  };
  items.forEach((item) => {
    add(item);
    (item.members || []).forEach(add);
  });
  return scope;
}

/**
 * Everything the sheet prints, read from the show and its renderers.
 *
 * @param {Object} show the Show
 * @param {Object|null} [scope] from `itemsScope`; null for the whole scene
 * @returns {Object} `{ title, date, rows, types, objects, measurements }`
 */
export function collectPatchSheet(show, scope = null) {
  const fixtures = show.fixturePool.fixtures
    .filter((f) => !scope || scope.fixtures.has(f));
  const patched = fixtures.filter((f) => PatchSingleton.isPatched(f))
    .sort((a, b) => a.address - b.address);
  const unpatched = fixtures.filter((f) => !PatchSingleton.isPatched(f))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  const types = new Map();
  const rows = patched.concat(unpatched).map((fixture, index) => {
    const model = fixture._3DModel;
    const isPatched = index < patched.length;
    const start = splitAddress(fixture.address);
    const end = splitAddress(Math.max(fixture.addressStop - 1, fixture.address));
    const mode = fixture.modeNames[fixture.modeIndex] || '';
    const type = typeName(fixture);
    const channels = fixture.channels.length;
    const owner = fixture.structure || fixture.group;
    const typeKey = `${type}\u0000${mode}`;
    const bearing = panCentreBearing(model, tiltRises(fixture));
    if (!types.has(typeKey)) {
      types.set(typeKey, {
        type, mode, channels, count: 0,
      });
    }
    types.get(typeKey).count += 1;
    const { x, y, z } = fixture.position;
    return {
      number: index + 1,
      label: fixture.label,
      type,
      mode,
      channels,
      patched: isPatched,
      universe: start.universe,
      start: start.channel,
      endUniverse: end.universe,
      end: end.channel,
      location: owner ? (owner.label || owner.name || '') : '',
      position: { x, y, z },
      mount: mountOf(model),
      bearing,
      corners: bodyCorners(model),
    };
  });

  const objects = show.objects
    .filter((object) => !object.isHidden && !object._hidden)
    .filter((object) => !scope || scope.objects.has(object))
    .map((object) => ({ corners: objectCorners(object) }))
    .filter((object) => object.corners);

  // Measurements tied to items read where those items are now.
  MeasureTool.refresh();
  return {
    title: show.documentTitle,
    author: show.details.author.trim(),
    version: show.details.version.trim(),
    notes: show.details.notes,
    appVersion: import.meta.env.VITE_APP_VERSION || '',
    // Local date: the UTC one is a day out for half of each day east of Greenwich.
    date: new Date().toLocaleDateString('en-CA'),
    selection: !!scope,
    rows,
    types: [...types.values()]
      .sort((a, b) => a.type.localeCompare(b.type) || a.mode.localeCompare(b.mode)),
    objects,
    measurements: MeasureTool.state.measurements.map((m) => ({
      number: m.number,
      kind: m.kind,
      headline: m.headline,
      details: detailsOf(m),
      ends: m.ends.map((end) => ({
        x: end.point.x, y: end.point.y, z: end.point.z, label: end.label,
      })),
    })),
  };
}

/**
 * A small arrow pointing along a plan bearing, for the table.
 *
 * @param {Number} bearing degrees anticlockwise from +X
 * @returns {String} inline SVG
 */
function arrowIcon(bearing) {
  // SVG turns clockwise with y down; the plan's y is up.
  return '<svg class="arrow" viewBox="-8 -8 16 16" width="14" height="14">'
    + `<g transform="rotate(${(-bearing).toFixed(1)})">`
    + '<line x1="-6" y1="0" x2="5" y2="0"/><path d="M6 0 L1 -4 L1 4 Z"/></g></svg>';
}

/**
 * Plan bearing as the side of the stage it faces. The audience is at -Y.
 *
 * @param {Number} bearing degrees anticlockwise from +X
 * @returns {String}
 */
export function bearingWords(bearing) {
  const names = ['stage left', 'upstage left', 'upstage', 'upstage right',
    'stage right', 'downstage right', 'downstage', 'downstage left'];
  // +X is stage left from the performer's view, facing the audience at -Y.
  const step = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return names[step];
}

/**
 * Fixture numbers as a short list: runs of three or more as a range.
 *
 * @param {Array<Number>} numbers
 * @returns {String} such as `1–8` or `2, 3, 9`
 */
export function numberList(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    if (j - i >= 2) parts.push(`${sorted[i]}\u2013${sorted[j]}`);
    else for (let k = i; k <= j; k += 1) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Where a view sits on the page: its extent in metres across and up, its depth
 * range, and the scale that fits it to the paper.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @param {String} key a key of `VIEWS`
 * @param {Object} [options] as `PATCH_SHEET_DEFAULTS`
 * @returns {Object|null} null when there is nothing to draw
 */
export function layoutView(sheet, key, options) {
  const opt = withDefaults(options);
  const view = VIEWS[key];
  const project = projector(view);
  const points = [];
  sheet.objects.forEach((o) => o.corners.forEach((p) => points.push(project(p))));
  sheet.rows.forEach((r) => {
    points.push(project([r.position.x, r.position.y, r.position.z]));
    if (r.corners) r.corners.forEach((p) => points.push(project(p)));
  });
  if (opt.measurements) {
    (sheet.measurements || []).forEach((m) => m.ends
      .forEach((end) => points.push(project([end.x, end.y, end.z]))));
  }
  if (!points.length) return null;
  const extent = (i) => {
    const values = points.map((p) => p[i]);
    return [Math.min(...values), Math.max(...values)];
  };
  let [minU, maxU] = extent(0);
  let [minV, maxV] = extent(1);
  const [minD, maxD] = extent(2);
  const margin = Math.max(maxU - minU, maxV - minV, 2) * 0.06 + 0.5;
  minU -= margin; maxU += margin; minV -= margin; maxV += margin;
  const plotWidth = Math.round(PAPER[opt.paper].width * PX_PER_MM) - PLOT_SIDES;
  const plotHeight = PLOT_HEIGHT;
  const scale = Math.min(plotWidth / (maxU - minU), plotHeight / (maxV - minV));
  const width = (maxU - minU) * scale;
  const height = (maxV - minV) * scale;
  return {
    key,
    ...view,
    minU,
    maxU,
    minV,
    maxV,
    minD,
    maxD,
    scale,
    width,
    height,
    pixelsWide: width * IMAGE_SCALE,
    pixelsHigh: height * IMAGE_SCALE,
  };
}

/**
 * One view: the drawing of the objects when there is one, else their outlines;
 * fixtures numbered to match the table, dashed where something hides them;
 * on the plan, movers with the arrow `panCentreBearing` gives; measurements.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @param {Object} layout from `layoutView`
 * @param {Object} [options] as `PATCH_SHEET_DEFAULTS`
 * @param {Object} [drawn] `{ image, hidden }`: the drawing's data URL and the
 *   numbers of the fixtures it hides
 * @returns {String} SVG markup
 */
export function viewSvg(sheet, layout, options, drawn) {
  const opt = withDefaults(options);
  const project = projector(layout);
  const {
    minU, maxU, minV, maxV, scale, width, height,
  } = layout;
  const hidden = new Set((drawn && drawn.hidden) || []);
  const measurements = opt.measurements ? sheet.measurements || [] : [];
  const px = (u) => ((u - minU) * scale).toFixed(1);
  const py = (v) => ((maxV - v) * scale).toFixed(1);
  const outline = (corners) => hull(corners.map((p) => project(p)).map((p) => [p[0], p[1]]));
  const polygon = (points, cls) => `<polygon class="${cls}" points="${
    points.map((p) => `${px(p[0])},${py(p[1])}`).join(' ')}"/>`;
  const elevation = layout.key !== 'top';

  // Grid lines every 1, 2, 5 or 10 m, whichever keeps them 40 px or more apart.
  const gridStep = [1, 2, 5, 10, 20, 50].find((st) => st * scale >= 40) || 100;
  const grid = [];
  const firstU = opt.grid ? Math.ceil(minU / gridStep) * gridStep : Infinity;
  for (let u = firstU; u <= maxU; u += gridStep) {
    grid.push(`<line class="${u === 0 ? 'axis' : 'grid'}" x1="${px(u)}" y1="0" x2="${px(u)}" y2="${height.toFixed(1)}"/>`);
    grid.push(`<text class="gridlabel" x="${px(u)}" y="${(height - 3).toFixed(1)}">${u} m</text>`);
  }
  const firstV = opt.grid ? Math.ceil(minV / gridStep) * gridStep : Infinity;
  for (let v = firstV; v <= maxV; v += gridStep) {
    grid.push(`<line class="${v === 0 ? 'axis' : 'grid'}" x1="0" y1="${py(v)}" x2="${width.toFixed(1)}" y2="${py(v)}"/>`);
    grid.push(`<text class="gridlabel" x="3" y="${(Number(py(v)) - 3).toFixed(1)}">${v} m</text>`);
  }
  // The floor, in an elevation.
  if (elevation && minV < 0 && maxV > 0) {
    grid.push(`<line class="ground" x1="0" y1="${py(0)}" x2="${width.toFixed(1)}" y2="${py(0)}"/>`);
  }

  const objects = drawn && drawn.image
    ? [`<image href="${drawn.image}" x="0" y="0" width="${width.toFixed(1)}" height="${height.toFixed(1)}" preserveAspectRatio="none"/>`]
    : sheet.objects.map((o) => polygon(outline(o.corners), 'object'));
  // Bodies on the plan only: in an elevation a row of fixtures stacks them.
  const bodies = elevation ? [] : sheet.rows.filter((r) => r.corners)
    .map((r) => polygon(outline(r.corners), hidden.has(r.number) ? 'body hidden' : 'body'));
  const RADIUS = 9;
  const arrows = !elevation && opt.moverArrows;
  const centreOf = (r) => {
    const [u, v] = project([r.position.x, r.position.y, r.position.z]);
    return [Number(px(u)), Number(py(v))];
  };

  const arrowMarks = sheet.rows.filter((r) => arrows && r.bearing !== null).map((r) => {
    const [cx, cy] = centreOf(r);
    const a = THREE.MathUtils.degToRad(r.bearing);
    const dx = Math.cos(a);
    const dy = -Math.sin(a);
    const from = RADIUS;
    const to = RADIUS + 16;
    const tip = [cx + dx * to, cy + dy * to];
    const back = [cx + dx * (to - 6), cy + dy * (to - 6)];
    const side = [-dy * 4, dx * 4];
    return `<line class="pan" x1="${(cx + dx * from).toFixed(1)}" y1="${(cy + dy * from).toFixed(1)}" `
      + `x2="${back[0].toFixed(1)}" y2="${back[1].toFixed(1)}"/>`
      + `<polygon class="panhead" points="${tip[0].toFixed(1)},${tip[1].toFixed(1)} `
      + `${(back[0] + side[0]).toFixed(1)},${(back[1] + side[1]).toFixed(1)} `
      + `${(back[0] - side[0]).toFixed(1)},${(back[1] - side[1]).toFixed(1)}"/>`;
  });

  // Fixtures whose markers would cover each other share one, labelled with
  // all their numbers: a row of fixtures seen end on is one marker.
  const clusters = [];
  sheet.rows.forEach((r) => {
    const [x, y] = centreOf(r);
    const near = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < RADIUS * 1.5);
    if (near) near.rows.push(r);
    else clusters.push({ x, y, rows: [r] });
  });
  clusters.forEach((c) => {
    c.text = numberList(c.rows.map((r) => r.number));
    c.half = c.text.length > 2 ? (c.text.length * 5.6 + 8) / 2 : RADIUS;
  });
  const markers = clusters.map((c) => {
    const cls = ['marker',
      c.rows.every((r) => r.patched) ? '' : 'unpatched',
      c.rows.every((r) => hidden.has(r.number)) ? 'hidden' : '']
      .filter(Boolean).join(' ');
    const shape = c.half > RADIUS
      ? `<rect class="${cls}" x="${(c.x - c.half).toFixed(1)}" y="${(c.y - RADIUS).toFixed(1)}" `
        + `width="${(c.half * 2).toFixed(1)}" height="${RADIUS * 2}" rx="${RADIUS}"/>`
      : `<circle class="${cls}" cx="${c.x}" cy="${c.y}" r="${RADIUS}"/>`;
    return `${shape}<text class="number" x="${c.x}" y="${c.y + 3.5}">${c.text}</text>`;
  });

  // Measurements flattened onto the view. One whose ends are in line with the
  // view is a dot; its label carries the length. A label is moved off fixture
  // markers, their arrows and other labels, with a leader line back to its
  // place.
  const measureLines = [];
  const measureLabels = [];
  const taken = clusters.map((c) => ({
    x0: c.x - c.half - 1, y0: c.y - RADIUS - 1, x1: c.x + c.half + 1, y1: c.y + RADIUS + 1,
  }));
  sheet.rows.filter((r) => arrows && r.bearing !== null).forEach((r) => {
    const a = THREE.MathUtils.degToRad(r.bearing);
    const [cx, cy] = centreOf(r);
    const tx = cx + Math.cos(a) * (RADIUS + 16);
    const ty = cy - Math.sin(a) * (RADIUS + 16);
    taken.push({
      x0: tx - 5, y0: ty - 5, x1: tx + 5, y1: ty + 5,
    });
  });
  const clashes = (box) => taken.some((t) => box.x0 < t.x1 && box.x1 > t.x0
    && box.y0 < t.y1 && box.y1 > t.y0);
  measurements.forEach((m) => {
    const ends = m.ends.map((end) => {
      const [u, v] = project([end.x, end.y, end.z]);
      return [Number(px(u)), Number(py(v))];
    });
    for (let i = 1; i < ends.length; i += 1) {
      measureLines.push(`<line class="${m.kind === MEASURE_MODES.THROW ? 'measure throw' : 'measure'}" `
        + `x1="${ends[i - 1][0]}" y1="${ends[i - 1][1]}" x2="${ends[i][0]}" y2="${ends[i][1]}"/>`);
    }
    ends.forEach((p) => measureLines.push(`<circle class="measureend" cx="${p[0]}" cy="${p[1]}" r="2"/>`));
    const at = m.kind === MEASURE_MODES.ANGLE
      ? ends[1] : [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
    const flat = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]) < 4;
    const text = `M${m.number}  ${m.headline}`;
    const w = text.length * 4.6 + 8;
    const x = flat ? at[0] + 6 + w / 2 : at[0];
    let y = at[1];
    const boxAt = (cy) => ({
      x0: x - w / 2, y0: cy - 7, x1: x + w / 2, y1: cy + 7,
    });
    for (let step = 1; step <= 24 && clashes(boxAt(y)); step += 1) {
      y = at[1] + Math.ceil(step / 2) * 14 * (step % 2 ? -1 : 1);
    }
    taken.push(boxAt(y));
    const leader = Math.abs(y - at[1]) > 1
      ? `<line class="measureleader" x1="${at[0].toFixed(1)}" y1="${at[1].toFixed(1)}" `
        + `x2="${x.toFixed(1)}" y2="${(y + (y > at[1] ? -6 : 6)).toFixed(1)}"/>` : '';
    measureLabels.push(`${leader}<rect class="measurelabel" x="${(x - w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" `
      + `width="${w.toFixed(1)}" height="12" rx="2"/>`
      + `<text class="measuretext" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}">${escapeHtml(text)}</text>`);
  });

  return `<svg class="plot" width="${width.toFixed(0)}" height="${height.toFixed(0)}" `
    + `viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}">`
    + `${grid.join('')}${objects.join('')}${bodies.join('')}${measureLines.join('')}`
    + `${arrowMarks.join('')}${markers.join('')}${measureLabels.join('')}</svg>`;
}

/**
 * @param {Object} paper from `PAPER`
 * @returns {String} the sheet's style for that paper
 */
const style = (paper) => `
@page { size: ${paper.css} landscape; margin: 12mm 12mm 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9pt; color: #111; margin: 0;
  width: ${paper.width}mm; }
.pagebox { position: absolute; left: 0; top: 0; width: 1px; height: ${paper.height}mm; visibility: hidden; }
h1 { font-size: 15pt; margin: 0 0 2mm 0; }
.brand { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3mm;
  padding-bottom: 2.5mm; border-bottom: 0.8pt solid #111; }
.brand .titles h1 { margin: 0; }
.brand .mark { display: flex; align-items: center; gap: 3mm; text-align: right; }
.brand .mark img { width: 14mm; height: 14mm; }
.brand .wordmark { font-size: 13pt; font-weight: 700; letter-spacing: 0.4pt; }
.brand .wordmark span { color: #2fa84f; }
.brand .url { font-size: 8pt; color: #444; text-decoration: none; }
.usernotes { border: 0.6pt solid #888; border-left: 2.5pt solid #2fa84f; padding: 2mm 3mm;
  margin: 0 0 3mm 0; white-space: pre-wrap; font-size: 9.5pt; }
.usernotes h3 { margin: 0 0 1mm 0; font-size: 10pt; white-space: normal; }
h2 { font-size: 11pt; margin: 5mm 0 2mm 0; }
.meta { color: #444; margin-bottom: 3mm; }
.notes { margin: 0 0 3mm 0; padding-left: 5mm; color: #333; }
.notes li { margin: 0.5mm 0; }
table { border-collapse: collapse; width: 100%; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { text-align: left; border-bottom: 1.2pt solid #111; padding: 1.2mm 1.5mm; font-weight: 600; white-space: nowrap; }
td { border-bottom: 0.4pt solid #bbb; padding: 1mm 1.5mm; vertical-align: middle; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.addr { font-weight: 700; font-size: 10pt; text-align: right; font-variant-numeric: tabular-nums; }
tr.universe td { background: #e8e8e8; font-weight: 700; border-bottom: 0.8pt solid #111; padding-top: 1.6mm; }
tr.unpatched td { color: #777; }
.dim { color: #666; }
.arrow line { stroke: #111; stroke-width: 1.6; }
.arrow path { fill: #111; }
.plotpage.newpage { page-break-before: always; }
.measurepage { page-break-before: always; }
.keep { break-inside: avoid; }
table.types { width: auto; min-width: 50%; }
.plotwrap { display: grid; grid-template-columns: auto auto auto; justify-content: center;
  align-items: center; gap: 1.5mm 2mm; }
.stage { font-weight: 700; letter-spacing: 1pt; text-align: center; font-size: 9pt; }
.stage.side { writing-mode: vertical-rl; }
.stage.right { transform: rotate(180deg); }
.plot { border: 0.6pt solid #888; }
.plot .grid { stroke: #e3e3e3; stroke-width: 0.6; }
.plot .axis { stroke: #b0b0b0; stroke-width: 0.9; }
.plot .gridlabel { font-size: 7px; fill: #999; }
.plot .object { fill: rgba(150,150,150,0.25); stroke: #8a8a8a; stroke-width: 0.8; }
.plot .body { fill: rgba(60,60,60,0.25); stroke: #555; stroke-width: 0.6; }
.plot .marker { fill: #fff; stroke: #111; stroke-width: 1.2; }
.plot .marker.unpatched { stroke-dasharray: 2 2; stroke: #888; }
.plot .marker.hidden { stroke: #888; fill: rgba(255,255,255,0.75); }
.plot .body.hidden { fill: none; stroke: #999; stroke-dasharray: 2 2; }
.plot .ground { stroke: #555; stroke-width: 1.2; }
.plot .number { font-size: 9px; font-weight: 700; text-anchor: middle; }
.plot .pan { stroke: #c0392b; stroke-width: 1.6; }
.plot .panhead { fill: #c0392b; }
.plot .measure { stroke: #1f6fb2; stroke-width: 1.2; }
.plot .measure.throw { stroke-dasharray: 4 3; }
.plot .measureend { fill: #1f6fb2; }
.plot .measureleader { stroke: #1f6fb2; stroke-width: 0.6; stroke-dasharray: 1.5 1.5; }
.plot .measurelabel { fill: #fff; stroke: #1f6fb2; stroke-width: 0.8; }
.plot .measuretext { font-size: 8px; fill: #1f6fb2; text-anchor: middle; font-variant-numeric: tabular-nums; }
table.measurements td:first-child { color: #1f6fb2; font-weight: 700; }
`;

/**
 * Run in the print window: when the patch table would start in the lower half
 * of a page, it starts on the next one instead. The body is set to the
 * printed width of the paper less margins, so the measured layout is the
 * printed one.
 */
const BREAK_IF_LOW = [
  '(function () {',
  "  var page = document.getElementById('pagebox').getBoundingClientRect().height;",
  "  var table = document.getElementById('patch');",
  '  if (!table) return;',
  '  var start = table.getBoundingClientRect().top + window.scrollY;',
  "  if (start % page > page / 2) table.style.breakBefore = 'page';",
  '}());',
].join('\n');

/**
 * The whole sheet as one HTML page, ready to print to PDF.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @param {Object} [options] as `PATCH_SHEET_DEFAULTS`
 * @returns {String}
 */
export function patchSheetHtml(sheet, options) {
  const opt = withDefaults(options);
  const patchedRows = sheet.rows.filter((r) => r.patched);
  const allUnpatched = sheet.rows.filter((r) => !r.patched);
  // Left out, unpatched fixtures are counted in the line under the title only.
  const shown = opt.unpatched ? sheet : { ...sheet, rows: patchedRows };
  const unpatchedRows = opt.unpatched ? allUnpatched : [];
  const universes = [...new Set(patchedRows.map((r) => r.universe))];
  const movers = sheet.rows.some((r) => r.bearing !== null);
  // The Location column is left out when no fixture is in a group or structure.
  const located = sheet.rows.some((r) => r.location);
  const columns = located ? 13 : 12;

  const row = (r) => {
    const end = r.endUniverse !== r.universe ? `${r.endUniverse}/${r.end}` : `${r.end}`;
    const pan = r.bearing !== null
      ? `${arrowIcon(r.bearing)} <span class="dim">${bearingWords(r.bearing)}</span>` : '';
    return `<tr class="${r.patched ? '' : 'unpatched'}">`
      + `<td class="num">${r.number}</td>`
      + `<td>${escapeHtml(r.label)}</td>`
      + `<td>${escapeHtml(r.type)}</td>`
      + `<td>${escapeHtml(r.mode)}</td>`
      + `<td class="num">${r.channels}</td>`
      + `<td class="num">${r.patched ? r.universe : ''}</td>`
      + `<td class="num">${r.patched ? r.universe + 1 : ''}</td>`
      + `<td class="addr">${r.patched ? r.start : 'not patched'}</td>`
      + `<td class="num dim">${r.patched ? end : ''}</td>`
      + `${located ? `<td>${escapeHtml(r.location)}</td>` : ''}`
      + `<td class="num dim">${r.position.x.toFixed(2)}, ${r.position.y.toFixed(2)}, ${r.position.z.toFixed(2)}</td>`
      + `<td>${r.mount}</td>`
      + `<td>${pan}</td>`
      + '</tr>';
  };

  const body = [];
  universes.forEach((universe) => {
    const inUniverse = patchedRows.filter((r) => r.universe === universe);
    body.push(`<tr class="universe"><td colspan="${columns}">Art-Net universe ${universe} &nbsp;/&nbsp; `
      + `sACN universe ${universe + 1} &nbsp;&middot;&nbsp; ${inUniverse.length} `
      + `${inUniverse.length === 1 ? 'fixture' : 'fixtures'}</td></tr>`);
    inUniverse.forEach((r) => body.push(row(r)));
  });
  if (unpatchedRows.length) {
    body.push(`<tr class="universe"><td colspan="${columns}">Not patched &nbsp;&middot;&nbsp; ${unpatchedRows.length}</td></tr>`);
    unpatchedRows.forEach((r) => body.push(row(r)));
  }

  // Empty lists are left out, headings included.
  const listed = opt.patchList && body.length > 0;

  const types = sheet.types.map((t) => '<tr>'
    + `<td>${escapeHtml(t.type)}</td>`
    + `<td class="num">${t.channels}</td><td class="num">${t.count}</td>`
    + '</tr>').join('');

  const measurements = opt.measurements ? sheet.measurements || [] : [];
  const measureRows = measurements.map((m) => '<tr>'
    + `<td>M${m.number}</td>`
    + `<td>${escapeHtml(m.details.map(([label, text]) => `${label} ${text}`).join(', '))}</td>`
    + `<td class="dim">${escapeHtml(m.ends.map((end) => end.label).join(' \u2192 '))}</td>`
    + '</tr>').join('');

  const notes = [
    'Universes are given twice: Art-Net counts from 0, sACN counts from 1. Set the fixture to the start channel shown, in the universe of the protocol the console sends.',
    'Set every fixture to the mode shown. The address is only correct in that mode.',
    'A start and end in different universes means the fixture continues into the next universe.',
    'Position is x, y, z in metres. +x is stage left, +y is upstage, z is height. The audience is at -y.',
  ];
  if (movers && (listed || (opt.viewTop && opt.moverArrows))) {
    notes.push('Movers: the arrow shows where the beam moves when tilt is raised above its centre with pan at its centre. '
      + 'The arrow does not show where the display or controls on the base face. '
      + 'To check a mover on site, set pan to centre and tilt slightly above centre, then turn the base until the beam points along the arrow.');
  }

  const patchTable = '<table id="patch"><thead><tr>'
    + '<th class="num">#</th><th>Fixture</th><th>Type</th><th>Mode</th><th class="num">Ch</th>'
    + '<th class="num">Art-Net</th><th class="num">sACN</th><th class="num">Start</th><th class="num">End</th>'
    + `${located ? '<th>Location</th>' : ''}`
    + '<th class="num">x, y, z (m)</th><th>Mount</th><th>Pan centre</th>'
    + `</tr></thead><tbody>${body.join('')}</tbody></table>`;
  const typesTable = '<div class="keep"><h2>Fixture types</h2>'
    + '<table class="types"><thead><tr><th>Type</th><th class="num">Channels</th><th class="num">Count</th>'
    + `</tr></thead><tbody>${types}</tbody></table></div>`;
  const measureTable = measurements.length
    ? '<h2>Measurements</h2><table class="measurements"><thead><tr>'
      + '<th>#</th><th>Values</th><th>Between</th>'
      + `</tr></thead><tbody>${measureRows}</tbody></table>` : '';
  const views = Object.keys(VIEWS).filter((key) => opt[VIEWS[key].option])
    .map((key) => {
      const drawn = sheet.views && sheet.views[key];
      return { layout: drawn ? drawn.layout : layoutView(shown, key, opt), drawn };
    })
    .filter((view) => view.layout);
  const viewPage = ({ layout, drawn }) => {
    const note = [layout.seen];
    if (listed) note.push('Numbers match the # column.');
    if (layout.key === 'top' && movers && opt.moverArrows) note.push('Red arrows: where each mover\'s beam moves when tilt is raised above centre with pan at centre.');
    if (unpatchedRows.length) note.push('Dashed circles are not patched.');
    if (layout.key !== 'top') note.push('Grey dashed outlines are fixtures hidden behind something in this view.');
    if (measurements.length) note.push('Blue: measurements, seen from this side; the full values are listed after the last view.');
    const label = (text, cls) => `<div class="stage${cls}">${text}</div>`;
    return `<div class="plotpage newpage"><h1>${layout.title}</h1>`
      + `<div class="meta">${note.join(' ')}</div>`
      + `<div class="plotwrap"><div></div>${label(layout.labels.top, '')}<div></div>`
      + `${label(layout.labels.left, ' side right')}${viewSvg(shown, layout, opt, drawn)}`
      + `${label(layout.labels.right, ' side')}`
      + `<div></div>${label(layout.labels.bottom, '')}<div></div></div></div>`;
  };

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sheet.title)} patch sheet</title>`
    + `<style>${style(PAPER[opt.paper])}</style></head><body>`
    + '<div class="brand"><div class="titles">'
    + `<h1>${escapeHtml(sheet.title)} &ndash; patch sheet</h1></div>`
    + '<div class="mark"><div>'
    + '<div class="wordmark">BEATLINE <span>BEAM</span></div>'
    + `<a class="url" href="${BEAM_URL}">${BEAM_URL}</a></div>`
    + `${sheet.logo ? `<img src="${sheet.logo}" alt="Beatline Beam">` : ''}</div></div>`
    + '<div class="meta">'
    + `${sheet.version ? `Version ${escapeHtml(sheet.version)} &nbsp;&middot;&nbsp; ` : ''}`
    + `${sheet.author ? `${escapeHtml(sheet.author)} &nbsp;&middot;&nbsp; ` : ''}`
    + `${sheet.selection ? 'Selection only &nbsp;&middot;&nbsp; ' : ''}`
    + `${sheet.date} &nbsp;&middot;&nbsp; ${patchedRows.length} patched `
    + `${patchedRows.length === 1 ? 'fixture' : 'fixtures'}${allUnpatched.length ? `, ${allUnpatched.length} not patched` : ''}`
    + ` &nbsp;&middot;&nbsp; ${universes.length} ${universes.length === 1 ? 'universe' : 'universes'}</div>`
    + `${opt.notes && sheet.notes.trim() ? `<div class="usernotes"><h3>Notes</h3>${escapeHtml(sheet.notes.trim())}</div>` : ''}`
    + `${opt.instructions ? `<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}`
    + `${listed ? patchTable : ''}`
    + `${opt.fixtureTypes && sheet.types.length ? typesTable : ''}`
    + `${views.map(viewPage).join('')}`
    // The measurements after the views, on a page of their own.
    + `${measureTable ? `<div class="keep${views.length ? ' measurepage' : ''}">${measureTable}</div>` : ''}`
    + `<div class="pagebox" id="pagebox"></div><script>${BREAK_IF_LOW}</script>`
    + '</body></html>';
}

/**
 * Draws each chosen view's objects, and finds the fixtures something hides in
 * each.
 *
 * @param {Object} sheet from `collectPatchSheet`
 * @param {Object} [options] as `PATCH_SHEET_DEFAULTS`
 * @returns {Object} by view key, `{ layout, image, hidden }`
 */
export function drawViews(sheet, options) {
  const opt = withDefaults(options);
  const shown = opt.unpatched ? sheet : { ...sheet, rows: sheet.rows.filter((r) => r.patched) };
  const views = {};
  Object.keys(VIEWS).filter((key) => opt[VIEWS[key].option]).forEach((key) => {
    const layout = layoutView(shown, key, opt);
    if (!layout) return;
    const drawing = LineDrawing.drawObjects(layout);
    const project = projector(layout);
    const hidden = shown.rows.filter((r) => {
      const [u, v, d] = project([r.position.x, r.position.y, r.position.z]);
      return drawing.depthAt(u, v) < d - HIDDEN_MARGIN_M;
    }).map((r) => r.number);
    views[key] = { layout, image: drawing.dataUrl, hidden };
  });
  return views;
}

/**
 * The logo as a data URL: the PDF is printed from a page in a temporary
 * file, which cannot load the app's own asset URLs.
 *
 * @returns {Promise<String|null>}
 */
async function logoDataUrl() {
  try {
    const blob = await (await fetch(logoUrl)).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return null;
  }
}

/**
 * Builds the sheet and asks where to save it as a PDF.
 *
 * @param {Object} show the Show
 * @param {Object} [options] as `PATCH_SHEET_DEFAULTS`
 * @param {Object|null} [scope] from `itemsScope`; null for the whole scene
 * @returns {Promise<String|null>} the path written, or null when cancelled
 */
export async function exportPatchSheet(show, options, scope = null) {
  if (!window.fileExport) return null;
  const sheet = collectPatchSheet(show, scope);
  sheet.logo = await logoDataUrl();
  sheet.views = drawViews(sheet, options);
  return window.fileExport.save({
    pdfFromHtml: patchSheetHtml(sheet, options),
    pdfFooter: `Beatline Beam ${sheet.appVersion}  ·  ${BEAM_URL}`,
    defaultName: `${sheet.title} patch sheet.pdf`,
    startIn: 'documents',
    startDir: show.documentFolder,
    folderKey: `patch-sheet|${show.documentPath || ''}`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    title: 'Export patch sheet',
  });
}
