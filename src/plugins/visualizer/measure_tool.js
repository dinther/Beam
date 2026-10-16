import * as THREE from 'three';
import {
  reactive, markRaw, toRaw, watch,
} from 'vue';
import Selection from '@/models/DMX/selection';
import ViewFilter, { MEASURE_FILTERS } from '@/models/DMX/view_filter';
import SceneObjects from './scene_objects';
import {
  featureEdges, closestOnSegment, closestOnLine, footOnPlane, closestOnLineToRay,
  angleAt, distanceBetween, lineAngle, angleToX, formatLength, formatAngle,
} from './measure_math';

/**
 * @file The measure tool: distances, angles and a fixture's throw, picked in
 * the 3D view with snapping to vertices, edges, faces and fixture points.
 *
 * Drawn as an HTML overlay over the canvas, so measurements are never in a
 * recording or a copied view. Measurements are drawn only while the tool is
 * on. They are kept until deleted, saved with the project, and drawn on the
 * patch sheet's plan.
 *
 * The viewport hands its camera, canvas and pick targets over in `attach`;
 * this module does not import the controls, which import it.
 */

export const MEASURE_MODES = {
  DISTANCE: 'distance',
  ANGLE: 'angle',
  THROW: 'throw',
};

/** How close, in screen pixels, the pointer must be for each snap. */
const SNAP_PX = {
  measure: 10,
  vertex: 10,
  midpoint: 9,
  perpendicular: 14,
  axis: 10,
  edge: 7,
};

/** Snaps in the order they win, when several are within reach. */
const SNAP_ORDER = ['measure', 'vertex', 'fixture', 'midpoint', 'perpendicular', 'axis', 'edge', 'face', 'floor'];

/** The axis colours: x red, y green, z blue, as the gizmo draws them. */
const AXES = {
  x: { dir: new THREE.Vector3(1, 0, 0), colour: '#e5484d' },
  y: { dir: new THREE.Vector3(0, 1, 0), colour: '#46a758' },
  z: { dir: new THREE.Vector3(0, 0, 1), colour: '#3e8ed0' },
};

/** Arrow keys that lock an axis, as SketchUp has them. */
const AXIS_KEYS = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };

const LINE_COLOUR = '#ffffff';
/** A locked axis, and the line to the snap its value is taken from. */
const LOCK_COLOUR = '#a855f7';
const HIGHLIGHT_COLOUR = '#1ca6bd';
const LABEL_HEIGHT = 18;
/** How close, in screen pixels, a click must be to a line to pick it. */
const PICK_LINE_PX = 5;

const FLOOR = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const UP = new THREE.Vector3(0, 0, 1);

const state = reactive({
  /** Whether clicks in the 3D view measure rather than select. */
  active: false,
  mode: MEASURE_MODES.DISTANCE,
  /** Finished measurements, in the order they were made. */
  measurements: [],
  /** The selected measurement, which Delete removes. */
  selectedId: null,
  /** The measurement under the pointer in the widget, drawn lit. */
  hoverId: null,
  /** Ends placed so far for the measurement under way. */
  pending: [],
  /** The axis an arrow key has locked, or null. */
  axisLock: null,
  /** A one-line note from the last click, such as a beam that meets nothing. */
  message: '',
});

let context = null;
let nextId = 1;
let pointer = null;
let pointerDirty = false;
let hover = null;
let overlay = null;
let frame = 0;
let changed = null;
/** The axis Shift locked, released when Shift is let go; null otherwise. */
let shiftLock = null;
let keysBound = false;

/** Tells the owner of the measurements, the show, that they changed. */
function notifyChanged() {
  if (changed) changed();
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const instanceMatrix = new THREE.Matrix4();
const inverseMatrix = new THREE.Matrix4();
const normalMatrix = new THREE.Matrix3();
const frameMatrix = new THREE.Matrix4();
const frameParts = {
  position: new THREE.Vector3(),
  euler: new THREE.Euler(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
};
/** How far, in metres, an end has to move to count as moved. */
const MOVED_M = 1e-6;

/**
 * An item's placement as a matrix: position and rotation from the scene node
 * the gizmo moves, so an end follows a drag while it happens rather than when
 * the model is written at its end; scale, for an object, from the model.
 * Without a node, the model's own position and rotation.
 *
 * @param {Object} item a fixture or an object
 * @param {THREE.Matrix4} target
 * @returns {THREE.Matrix4|null} null when the item has no usable placement
 */
function frameOf(item, target) {
  if (!item) return null;
  const {
    position, euler, quaternion, scale,
  } = frameParts;
  const model = toRaw(item._3DModel);
  const node = model && model._dummy;
  if (node) {
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(position, quaternion, scale);
  } else {
    const at = item.position;
    const turn = item.rotationRad;
    if (!at || !turn) return null;
    position.set(at.x, at.y, at.z);
    quaternion.setFromEuler(euler.set(turn.x, turn.y, turn.z));
  }
  const s = item.scale;
  if (s && typeof s === 'object') scale.set(s.x, s.y, s.z);
  else scale.set(1, 1, 1);
  target.compose(position, quaternion, scale);
  return Math.abs(target.determinant()) > 1e-12 ? target : null;
}

/**
 * Ties an end to the item it was snapped to: the point, normal and direction
 * in the item's own frame, so the end follows the item when it is moved,
 * turned or scaled.
 *
 * @param {Object} item a fixture or an object
 * @param {Object} fields `{ point, normal, dir }` in world space
 * @returns {Object|null} the anchor, or null for an item without a placement
 */
function anchorFor(item, { point, normal, dir }) {
  const placed = frameOf(item, frameMatrix);
  if (!placed) return null;
  const linear = new THREE.Matrix3().setFromMatrix4(placed);
  return {
    item,
    local: point.clone().applyMatrix4(placed.clone().invert()),
    // A normal goes back through the transpose and a direction through the
    // inverse, so both come out right again under a non-uniform scale.
    normal: normal ? normal.clone().applyMatrix3(linear.clone().transpose()).normalize() : null,
    dir: dir ? dir.clone().applyMatrix3(linear.clone().invert()).normalize() : null,
  };
}

/**
 * An end as a measurement keeps it: where it is, what it was snapped to, and
 * the face normal or edge direction that came with it. An end snapped to a
 * fixture or an object carries an anchor to it.
 *
 * @param {Object} fields
 * @returns {Object} raw, so Vue leaves the vectors alone
 */
function makeEnd(fields) {
  return markRaw({
    point: fields.point.clone(),
    normal: fields.normal ? fields.normal.clone() : null,
    dir: fields.dir ? fields.dir.clone() : null,
    kind: fields.kind,
    label: fields.keepLabel || fields.label,
    axis: fields.axis || null,
    anchor: fields.owner ? anchorFor(fields.owner, fields) : null,
  });
}

/**
 * @param {Object} item a scene item
 * @returns {String} its name as the lists show it
 */
function nameOf(item) {
  if (!item) return '';
  return item.label || item.name || '';
}

/**
 * @param {THREE.Vector3} point
 * @returns {Object|null} `{ x, y }` in pixels within the canvas, or null
 *   behind the camera
 */
function toScreen(point) {
  const { camera, width, height } = context.view;
  const p = point.clone().project(camera);
  if (p.z > 1 || p.z < -1) return null;
  return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
}

function screenDistance(point, cursor) {
  const s = toScreen(point);
  return s ? Math.hypot(s.x - cursor.x, s.y - cursor.y) : Infinity;
}

/**
 * World length of one screen pixel at a point, so a pixel tolerance can be
 * turned into a search radius in the scene.
 *
 * @param {THREE.Vector3} point
 * @returns {Number}
 */
function worldPerPixel(point) {
  const { camera, height } = context.view;
  if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / height;
  const depth = point.distanceTo(camera.position);
  return (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
}

/**
 * The world matrix of the instance a ray hit.
 *
 * @param {Object} hit
 * @returns {THREE.Matrix4}
 */
function hitMatrix(hit) {
  if (hit.object.isInstancedMesh && hit.instanceId !== undefined) {
    hit.object.getMatrixAt(hit.instanceId, instanceMatrix);
    return instanceMatrix.clone().premultiply(hit.object.matrixWorld);
  }
  return hit.object.matrixWorld.clone();
}

/**
 * Vertices, midpoints and points on the feature edges of the hit object near
 * the pointer.
 *
 * @param {Object} hit
 * @param {THREE.Matrix4} matrix the hit instance's world matrix
 * @param {Object} cursor `{ x, y }` in canvas pixels
 * @param {String} name the object's name, for the snap's label
 * @returns {Array} candidates
 */
function edgeCandidates(hit, matrix, cursor, name) {
  const edges = featureEdges(hit.object.geometry);
  inverseMatrix.copy(matrix).invert();
  const local = hit.point.clone().applyMatrix4(inverseMatrix);
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  const minScale = Math.max(Math.min(scale.x, scale.y, scale.z), 1e-6);
  const reach = Math.max(SNAP_PX.vertex, SNAP_PX.midpoint) * 1.5;
  const radius = (reach * worldPerPixel(hit.point)) / minScale;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const near = new THREE.Vector3();
  const out = [];
  for (let i = 0; i < edges.length; i += 6) {
    a.set(edges[i], edges[i + 1], edges[i + 2]);
    b.set(edges[i + 3], edges[i + 4], edges[i + 5]);
    // eslint-disable-next-line no-continue
    if (closestOnSegment(local, a, b, near).distanceTo(local) > radius) continue;
    const wa = a.clone().applyMatrix4(matrix);
    const wb = b.clone().applyMatrix4(matrix);
    const dir = wb.clone().sub(wa).normalize();
    [wa, wb].forEach((corner) => {
      out.push({
        kind: 'vertex', point: corner, dir, label: `vertex, ${name}`, d: screenDistance(corner, cursor),
      });
    });
    const middle = wa.clone().lerp(wb, 0.5);
    out.push({
      kind: 'midpoint', point: middle, dir, label: `midpoint, ${name}`, d: screenDistance(middle, cursor),
    });
    // The point on the edge nearest the pointer, found on screen and carried
    // back along the edge.
    const sa = toScreen(wa);
    const sb = toScreen(wb);
    if (sa && sb) {
      const ex = sb.x - sa.x;
      const ey = sb.y - sa.y;
      const length2 = ex * ex + ey * ey;
      const along2 = (cursor.x - sa.x) * ex + (cursor.y - sa.y) * ey;
      const t = length2 ? THREE.MathUtils.clamp(along2 / length2, 0, 1) : 0;
      const along = wa.clone().lerp(wb, t);
      out.push({
        kind: 'edge', point: along, dir, edgeA: wa, label: `edge, ${name}`, d: screenDistance(along, cursor),
      });
    }
  }
  return out;
}

/**
 * The points a fixture offers: its position, which on a mover is the tilt
 * axis; its lens; the middle of the bottom of its body; and the middle of its
 * body.
 *
 * @param {Object} fixture
 * @returns {Array} `{ name, point }`
 */
function fixturePoints(fixture) {
  const model = fixture && toRaw(fixture._3DModel);
  if (!model || !model._dummy) return [];
  const points = [];
  model._dummy.updateMatrixWorld(true);
  const position = model._dummy.getWorldPosition(new THREE.Vector3());
  points.push({ name: model._headDummy ? 'tilt axis' : 'position', point: position });
  if (model.lensWorldPosition) {
    points.push({ name: 'lens', point: model.lensWorldPosition(new THREE.Vector3()) });
  }
  const rest = model._restBounds;
  if (rest && !rest.isEmpty()) {
    const centre = rest.getCenter(new THREE.Vector3());
    const bottom = new THREE.Vector3(centre.x, centre.y, rest.min.z)
      .applyMatrix4(model._dummy.matrixWorld);
    // Under a hung fixture this is the top of its body: the face it hangs by.
    points.push({ name: 'body base', point: bottom });
  }
  if (model.expandBounds) {
    const box = new THREE.Box3();
    model.expandBounds(box);
    if (!box.isEmpty()) points.push({ name: 'centre', point: box.getCenter(new THREE.Vector3()) });
  }
  return points;
}

/**
 * What the pointer would place: the best snap within reach.
 *
 * @param {Object} event `{ clientX, clientY, ctrlKey }`
 * @returns {Object|null} a candidate, or null at the sky
 */
function snapAt(event) {
  const { element, camera } = context.view;
  const rect = element.getBoundingClientRect();
  const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  ndc.set((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const free = !!event.ctrlKey;
  const candidates = [];

  const hit = raycaster.intersectObjects(context.pickTargets(), false)
    .find((h) => context.shown(context.ownerOfHit(h)));
  const owner = hit ? context.ownerOfHit(hit) : null;
  let surface = null;
  if (hit && hit.object.userData.sceneObjectModel && hit.face) {
    const matrix = hitMatrix(hit);
    normalMatrix.getNormalMatrix(matrix);
    const normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    // Toward the camera, so a face seen from behind still reads as itself.
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    const name = nameOf(owner);
    surface = {
      kind: 'face', point: hit.point.clone(), normal, owner, label: `face, ${name}`, d: 0,
    };
    if (!free) {
      edgeCandidates(hit, matrix, cursor, name).forEach((c) => candidates.push({ ...c, owner }));
    }
  } else if (hit && owner && free) {
    surface = {
      kind: 'face', point: hit.point.clone(), normal: null, owner, label: `free, ${nameOf(owner)}`, d: 0,
    };
  } else if (hit && owner) {
    // Fixtures are picked by an invisible box; their own points are what is
    // worth measuring to.
    fixturePoints(owner).forEach(({ name, point }) => {
      candidates.push({
        kind: 'fixture', point, owner, label: `${name}, ${nameOf(owner)}`, d: screenDistance(point, cursor),
      });
    });
  } else {
    const point = raycaster.ray.intersectPlane(FLOOR, new THREE.Vector3());
    if (point) {
      surface = {
        kind: 'floor', point, normal: UP.clone(), label: 'floor', d: 0,
      };
    }
  }
  if (surface) candidates.push(surface);

  if (!free) {
    // The ends of the measurements made, and the earlier ends of the one
    // under way; the last one placed is where this measurement starts.
    const ends = [];
    state.measurements.forEach((m) => m.ends.forEach((end) => ends.push({ end, of: `end of ${m.number}` })));
    state.pending.slice(0, -1).forEach((end) => ends.push({ end, of: 'placed point' }));
    ends.forEach(({ end, of }) => {
      candidates.push({
        kind: 'measure',
        point: end.point.clone(),
        normal: end.normal,
        dir: end.dir,
        // Snapped to an end that follows an item, so this one follows it too.
        owner: end.anchor ? end.anchor.item : null,
        label: `${of}, ${end.label}`,
        // Stored as the point it was, so a chain of snaps does not grow the name.
        keepLabel: end.label,
        d: screenDistance(end.point, cursor),
      });
    });
  }

  const from = state.mode === MEASURE_MODES.THROW ? null : state.pending[state.pending.length - 1];
  // An end placed along an axis from the last point moves with that point's item.
  const fromItem = from && from.anchor ? from.anchor.item : null;
  if (from && !free) {
    // A perpendicular foot lies on a face or edge, and moves with its item.
    if (surface) {
      const foot = footOnPlane(from.point, surface.point, surface.normal, new THREE.Vector3());
      candidates.push({
        kind: 'perpendicular', point: foot, normal: surface.normal, owner: surface.owner, label: `perpendicular to ${surface.label}`, d: screenDistance(foot, cursor),
      });
    }
    candidates.filter((c) => c.kind === 'edge' && c.d <= SNAP_PX.edge * 2).forEach((edge) => {
      const foot = closestOnLine(from.point, edge.edgeA, edge.dir, new THREE.Vector3());
      candidates.push({
        kind: 'perpendicular', point: foot, dir: edge.dir, owner: edge.owner, label: `perpendicular to ${edge.label}`, d: screenDistance(foot, cursor),
      });
    });
    if (!state.axisLock) {
      Object.entries(AXES).forEach(([key, axis]) => {
        const point = closestOnLineToRay(raycaster.ray, from.point, axis.dir, new THREE.Vector3());
        candidates.push({
          kind: 'axis', axis: key, point, owner: fromItem, label: `on ${key} axis`, d: screenDistance(point, cursor),
        });
      });
    }
  }

  const within = (c) => c.kind === 'face' || c.kind === 'floor' || c.kind === 'fixture'
    || c.d <= SNAP_PX[c.kind];
  let best = null;
  SNAP_ORDER.some((kind) => {
    const matches = candidates.filter((c) => c.kind === kind && within(c));
    if (!matches.length) return false;
    best = matches.reduce((x, y) => (y.d < x.d ? y : x));
    return true;
  });

  // A locked axis keeps the end on the axis through the last point: the
  // snap found is carried onto it, or the pointer's nearest point if none.
  if (from && state.axisLock) {
    const axis = AXES[state.axisLock];
    const point = best && best.kind !== 'floor'
      ? from.point.clone()
        .addScaledVector(axis.dir, best.point.clone().sub(from.point).dot(axis.dir))
      : closestOnLineToRay(raycaster.ray, from.point, axis.dir, new THREE.Vector3());
    const source = best && best.kind !== 'floor' ? best : null;
    const label = source ? `on ${state.axisLock} axis, level with ${source.label}` : `on ${state.axisLock} axis`;
    // With the last point on nothing, the item it was levelled with.
    const follows = fromItem || (source && source.owner) || null;
    best = {
      kind: 'axis', axis: state.axisLock, locked: true, source, point, owner: follows, label, d: 0,
    };
  }
  if (best) best.cursor = cursor;
  return best;
}

/**
 * The text a measurement's label and its widget row lead with.
 *
 * @param {Object} measurement
 * @returns {String}
 */
function headline(measurement) {
  const v = measurement.values;
  const { showLength, showAngle } = measurement;
  const parts = [];
  const angle = labelAngle(measurement); // eslint-disable-line no-use-before-define
  if (measurement.kind === MEASURE_MODES.ANGLE) {
    if (showAngle && angle) parts.push(formatAngle(angle.shown));
    if (showLength) parts.push(`${formatLength(v.armA)} / ${formatLength(v.armC)}`);
    return parts.join(' · ');
  }
  if (showLength) {
    if (measurement.kind === MEASURE_MODES.THROW) parts.push(`throw ${formatLength(v.distance)}`);
    else parts.push(v.gap !== undefined ? `gap ${formatLength(v.gap)}` : formatLength(v.distance));
  }
  if (showAngle && angle) parts.push(formatAngle(angle.shown));
  return parts.join(' · ');
}

/**
 * The angle a measurement's label shows: a three-point angle's own, a face or
 * edge angle, or else the angle from +X to the line from the first point to
 * the second. Flipped, the first and last turn to 360 less, a face or edge
 * angle to 180 less.
 *
 * @param {Object} measurement
 * @returns {Object|null} `{ key, measured, shown }`, or null when it has none
 */
function labelAngle(measurement) {
  const v = measurement.values;
  let key = 'xAngle';
  if (measurement.kind === MEASURE_MODES.ANGLE) key = 'angle';
  else if (v.gap === undefined && v.faceAngle !== undefined) key = 'faceAngle';
  else if (v.edgeAngle !== undefined) key = 'edgeAngle';
  const measured = v[key];
  if (!Number.isFinite(measured)) return null;
  const turn = key === 'faceAngle' || key === 'edgeAngle' ? 180 : 360;
  return { key, measured, shown: measurement.flipAngle ? turn - measured : measured };
}

/**
 * What a new measurement's label shows: as it always has, so the angle to +X
 * and an angle's arm lengths start off.
 *
 * @param {String} kind
 * @param {Object} values
 * @returns {Object} `{ showLength, showAngle }`
 */
function labelDefaults(kind, values) {
  if (kind === MEASURE_MODES.ANGLE) return { showLength: false, showAngle: true };
  if (kind === MEASURE_MODES.THROW) return { showLength: true, showAngle: false };
  const own = (values.gap === undefined && values.faceAngle !== undefined)
    || values.edgeAngle !== undefined;
  return { showLength: true, showAngle: own };
}

/**
 * Every value a measurement has, as `[label, text]` rows for the widget and
 * the clipboard.
 *
 * @param {Object} measurement
 * @returns {Array}
 */
export function detailsOf(measurement) {
  const v = measurement.values;
  const rows = [];
  const add = (label, text) => rows.push([label, text]);
  // The angle the label uses reads as the label does, flipped or not.
  const shown = labelAngle(measurement);
  const angleOf = (key) => formatAngle(shown && shown.key === key ? shown.shown : v[key]);
  if (measurement.kind === MEASURE_MODES.ANGLE) {
    add('angle', angleOf('angle'));
    add('arms', `${formatLength(v.armA)}, ${formatLength(v.armC)}`);
    return rows;
  }
  if (measurement.kind === MEASURE_MODES.THROW) {
    add('throw', formatLength(v.distance));
    add('lens height', formatLength(v.lensHeight));
    add('horizontal', formatLength(v.horizontal));
    if (v.incidence !== undefined) add('incidence', formatAngle(v.incidence));
    if (v.xAngle !== undefined) add('angle to +x', angleOf('xAngle'));
    return rows;
  }
  if (v.gap !== undefined) add('gap', formatLength(v.gap));
  if (v.faceAngle !== undefined) add('face angle', angleOf('faceAngle'));
  if (v.edgeAngle !== undefined) add('edge angle', angleOf('edgeAngle'));
  if (v.xAngle !== undefined) add('angle to +x', angleOf('xAngle'));
  add('distance', formatLength(v.distance));
  add('horizontal', formatLength(v.horizontal));
  add('vertical', formatLength(v.vertical));
  add('Δx Δy Δz', [v.dx, v.dy, v.dz].map((n) => (Math.round(n * 1000) / 1000).toFixed(3)).join('  '));
  if (v.gap === undefined && v.perpA !== undefined) add('⊥ to first face', formatLength(v.perpA));
  if (v.gap === undefined && v.perpB !== undefined) add('⊥ to second face', formatLength(v.perpB));
  return rows;
}

/**
 * A measurement as plain text, for the clipboard.
 *
 * @param {Object} measurement
 * @returns {String}
 */
export function textOf(measurement) {
  const ends = measurement.ends.map((end) => end.label).join(' → ');
  const values = detailsOf(measurement).map(([label, text]) => `${label} ${text}`).join(', ');
  return `${measurement.number}  ${values}  (${ends})`;
}

function addMeasurement(kind, ends, values) {
  const measurement = {
    id: nextId,
    number: (state.measurements.length
      ? state.measurements[state.measurements.length - 1].number : 0) + 1,
    kind,
    hidden: false,
    ...labelDefaults(kind, values),
    flipAngle: false,
    ends: markRaw(ends),
    values,
  };
  nextId += 1;
  measurement.headline = headline(measurement);
  state.measurements.push(measurement);
  state.selectedId = measurement.id;
  notifyChanged();
  ensureLoop(); // eslint-disable-line no-use-before-define
}

/**
 * Measures a fixture's throw: from its lens along the beam to the first
 * surface, or the floor.
 *
 * @param {Object} event pointer event over the fixture
 */
function measureThrow(event) {
  const { element, camera } = context.view;
  const rect = element.getBoundingClientRect();
  ndc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(context.pickTargets(), false)
    .find((h) => context.shown(context.ownerOfHit(h)));
  const fixture = hit ? context.ownerOfHit(hit) : null;
  if (!fixture || hit.object.userData.sceneObjectModel) {
    state.message = 'Click a fixture with a lens to measure its throw.';
    return;
  }
  const measured = throwFrom(fixture); // eslint-disable-line no-use-before-define
  state.message = measured.message || '';
  if (measured.ends) addMeasurement(MEASURE_MODES.THROW, measured.ends, measured.values);
}

/**
 * A fixture's throw as it stands: from its lens along the beam to the first
 * surface, or the floor.
 *
 * @param {Object} fixture
 * @returns {Object} `{ ends, values }`, or `{ message }` when there is none
 */
function throwFrom(fixture) {
  const model = fixture && toRaw(fixture._3DModel);
  if (!model || !model.lensWorldPosition) {
    return { message: 'Click a fixture with a lens to measure its throw.' };
  }
  const lens = model.lensWorldPosition(new THREE.Vector3());
  const dir = model._beamDummy.getWorldDirection(new THREE.Vector3());
  const beam = new THREE.Raycaster(lens, dir, 0.01, 1000);
  const surfaces = SceneObjects.pickObjects();
  const landing = beam.intersectObjects(surfaces, false)
    .find((h) => context.shown(context.ownerOfHit(h)) && h.face);
  let end = null;
  if (landing) {
    normalMatrix.getNormalMatrix(hitMatrix(landing));
    const normal = landing.face.normal.clone().applyMatrix3(normalMatrix).normalize();
    const surface = context.ownerOfHit(landing);
    end = {
      point: landing.point, normal, owner: surface, kind: 'face', label: `face, ${nameOf(surface)}`,
    };
  }
  const floor = beam.ray.intersectPlane(FLOOR, new THREE.Vector3());
  if (floor && (!end || floor.distanceTo(lens) < end.point.distanceTo(lens))) {
    end = {
      point: floor, normal: UP.clone(), kind: 'floor', label: 'floor',
    };
  }
  if (!end) return { message: `The beam of ${nameOf(fixture)} meets nothing.` };
  const values = {
    distance: end.point.distanceTo(lens),
    lensHeight: lens.z,
    horizontal: Math.hypot(end.point.x - lens.x, end.point.y - lens.y),
    incidence: lineAngle(dir.clone().negate(), end.normal),
    xAngle: angleToX(end.point.clone().sub(lens)),
  };
  return {
    ends: [
      makeEnd({
        point: lens, dir, owner: fixture, kind: 'fixture', label: `lens, ${nameOf(fixture)}`,
      }),
      makeEnd(end),
    ],
    values,
  };
}

/**
 * Places the end under the pointer, and finishes a measurement once it has
 * all its ends.
 *
 * @public
 * @param {Object} event pointer event in the 3D view
 */
function click(event) {
  if (!state.active || !context) return;
  if (state.mode === MEASURE_MODES.THROW) {
    measureThrow(event);
    return;
  }
  const snap = snapAt(event);
  if (!snap) return;
  state.message = '';
  state.pending.push(makeEnd(snap));
  state.axisLock = null;
  shiftLock = null;
  const needed = state.mode === MEASURE_MODES.ANGLE ? 3 : 2;
  if (state.pending.length < needed) return;
  const ends = state.pending.splice(0);
  if (state.mode === MEASURE_MODES.ANGLE) {
    const [a, vertex, c] = ends;
    addMeasurement(MEASURE_MODES.ANGLE, ends, {
      angle: angleAt(a.point, vertex.point, c.point),
      armA: a.point.distanceTo(vertex.point),
      armC: c.point.distanceTo(vertex.point),
    });
  } else {
    addMeasurement(MEASURE_MODES.DISTANCE, ends, distanceBetween(ends[0], ends[1]));
  }
}

/**
 * Follows the pointer, for the live snap and readout.
 *
 * @public
 * @param {Object} event pointer event in the 3D view
 */
function pointerMove(event) {
  if (!state.active) return;
  pointer = {
    clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey || event.metaKey,
  };
  pointerDirty = true;
  ensureLoop(); // eslint-disable-line no-use-before-define
}

function pointerLeave() {
  pointer = null;
  hover = null;
}

/**
 * Shift held while the pointer is on an axis through the last point locks
 * that axis until Shift is released, as SketchUp does. Ctrl turns snapping
 * off; it is read here as well so pressing it without moving takes effect.
 *
 * @param {KeyboardEvent} e keydown or keyup
 */
function modifierKey(e) {
  if (!state.active) return;
  const down = e.type === 'keydown';
  if (e.key === 'Shift') {
    if (down && !state.axisLock && hover && hover.kind === 'axis' && state.pending.length) {
      state.axisLock = hover.axis;
      shiftLock = hover.axis;
    } else if (!down && shiftLock) {
      if (state.axisLock === shiftLock) state.axisLock = null;
      shiftLock = null;
    }
    pointerDirty = true;
  } else if ((e.key === 'Control' || e.key === 'Meta') && pointer) {
    pointer.ctrlKey = down;
    pointerDirty = true;
  }
}

/* ---------------------------------------------------------------- drawing */

function ensureOverlay() {
  if (overlay) return overlay;
  const root = document.createElement('div');
  root.className = 'measure_overlay';
  root.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:50;'
    + 'font:11px Roboto-Regular, sans-serif;';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;';
  const labels = document.createElement('div');
  labels.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;';
  root.append(svg, labels);
  // A label picks its measurement. On pointerdown, because the labels are
  // rebuilt every frame and a click would land on a replaced element.
  labels.addEventListener('pointerdown', (e) => {
    const id = Number(e.target.closest('[data-id]') && e.target.closest('[data-id]').dataset.id);
    if (id) {
      select(id); // eslint-disable-line no-use-before-define
      e.stopPropagation();
    }
  });
  document.body.appendChild(root);
  overlay = { root, svg, labels };
  return overlay;
}

const line = (a, b, colour, width, dash = '') => `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" `
  + `x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#000" stroke-opacity="0.55" `
  + `stroke-width="${width + 2}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
  + `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" `
  + `stroke="${colour}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

const dot = (p, colour, r = 3) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" `
  + `fill="${colour}" stroke="#000" stroke-opacity="0.6"/>`;

/** The marker that says what the pointer has snapped to. */
function marker(snap, p) {
  const x = p.x.toFixed(1);
  const y = p.y.toFixed(1);
  const stroke = 'stroke="#000" stroke-opacity="0.7" stroke-width="1"';
  switch (snap.kind) {
    case 'vertex':
      return `<rect x="${(p.x - 5).toFixed(1)}" y="${(p.y - 5).toFixed(1)}" width="10" height="10" fill="#22c55e" ${stroke}/>`;
    case 'midpoint':
      return `<polygon points="${x},${(p.y - 6).toFixed(1)} ${(p.x + 6).toFixed(1)},${(p.y + 5).toFixed(1)} ${(p.x - 6).toFixed(1)},${(p.y + 5).toFixed(1)}" fill="#22d3ee" ${stroke}/>`;
    case 'edge':
      return `<rect x="${(p.x - 4).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="8" height="8" transform="rotate(45 ${x} ${y})" fill="#f87171" ${stroke}/>`;
    case 'perpendicular':
      return `<path d="M${(p.x - 6).toFixed(1)} ${(p.y + 6).toFixed(1)}h12M${x} ${(p.y + 6).toFixed(1)}v-12" stroke="#f472b6" stroke-width="2.5" fill="none"/>`;
    case 'axis':
      return dot(p, AXES[snap.axis].colour, 5);
    case 'measure':
      return `<circle cx="${x}" cy="${y}" r="6" fill="${HIGHLIGHT_COLOUR}" stroke="#fff" stroke-width="2"/>`;
    case 'fixture':
      return `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="#facc15" stroke-width="2"/>${dot(p, '#facc15', 2)}`;
    default:
      return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#e5e7eb" stroke-width="1.5"/>`;
  }
}

function labelHtml(text, p, id, highlighted) {
  const background = highlighted ? HIGHLIGHT_COLOUR : 'rgba(18,18,20,0.88)';
  return `<div data-id="${id || ''}" style="position:absolute;left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px;`
    + 'transform:translate(-50%,-50%);padding:1px 6px;border-radius:3px;white-space:nowrap;color:#fff;'
    + `background:${background};pointer-events:${id ? 'auto' : 'none'};cursor:${id ? 'pointer' : 'default'};`
    + `line-height:${LABEL_HEIGHT - 2}px">${text}</div>`;
}

/**
 * Moves labels down until none overlaps another.
 *
 * @param {Array} placed `{ p, text }`
 */
function spreadLabels(placed) {
  const boxes = [];
  placed.forEach((label) => {
    const width = label.text.length * 6.2 + 24;
    for (let tries = 0; tries < 6; tries += 1) {
      const clash = boxes.some((b) => Math.abs(b.x - label.p.x) < (b.w + width) / 2
        && Math.abs(b.y - label.p.y) < LABEL_HEIGHT);
      if (!clash) break;
      label.p = { x: label.p.x, y: label.p.y + LABEL_HEIGHT + 2 };
    }
    boxes.push({ x: label.p.x, y: label.p.y, w: width });
  });
}

/**
 * Takes the camera and canvas size as they are now, for projecting points.
 *
 * @returns {DOMRect} the canvas's rectangle
 */
function updateView() {
  const rect = context.view.element.getBoundingClientRect();
  context.view.camera = context.camera();
  context.view.width = rect.width;
  context.view.height = rect.height;
  return rect;
}

/** One frame of the overlay. */
function draw() {
  if (!context) return;
  const rect = updateView();
  const o = ensureOverlay();
  Object.assign(o.root.style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  });
  const snapping = state.active && state.mode !== MEASURE_MODES.THROW;
  if (snapping && pointer && pointerDirty) {
    hover = snapAt(pointer);
    pointerDirty = false;
  }
  if (!snapping || !pointer) hover = null;

  let svg = '';
  const labels = [];
  state.measurements.filter(isDrawn).forEach((m) => { // eslint-disable-line no-use-before-define
    const lit = m.id === state.selectedId || m.id === state.hoverId;
    const colour = lit ? HIGHLIGHT_COLOUR : LINE_COLOUR;
    const width = lit ? 2.5 : 1.5;
    const screens = m.ends.map((end) => toScreen(end.point));
    if (screens.some((s) => !s)) return;
    for (let i = 1; i < screens.length; i += 1) {
      svg += line(screens[i - 1], screens[i], colour, width, m.kind === MEASURE_MODES.THROW ? '6 4' : '');
    }
    screens.forEach((s) => { svg += dot(s, colour); });
    const at = m.kind === MEASURE_MODES.ANGLE
      ? screens[1]
      : { x: (screens[0].x + screens[1].x) / 2, y: (screens[0].y + screens[1].y) / 2 };
    // Everything the label could say switched off: the line is drawn alone.
    if (!m.headline) return;
    labels.push({
      p: { x: at.x, y: at.y - (m.kind === MEASURE_MODES.ANGLE ? 14 : 0) },
      text: m.headline,
      id: m.id,
      lit,
    });
  });

  // The measurement under way: placed ends, and the leg to the pointer.
  const pending = state.pending.map((end) => toScreen(end.point));
  for (let i = 1; i < pending.length; i += 1) {
    const [a, b] = [pending[i - 1], pending[i]];
    if (a && b) svg += line(a, b, HIGHLIGHT_COLOUR, 1.5);
  }
  pending.forEach((s) => { if (s) svg += dot(s, HIGHLIGHT_COLOUR); });
  if (hover) {
    const p = toScreen(hover.point);
    const last = state.pending[state.pending.length - 1];
    if (p) {
      if (last) {
        const from = toScreen(last.point);
        if (from && hover.locked) svg += line(from, p, LOCK_COLOUR, 2.5);
        else if (from) {
          const colour = hover.kind === 'axis' ? AXES[hover.axis].colour : HIGHLIGHT_COLOUR;
          svg += line(from, p, colour, 1.5, '5 3');
        }
      }
      // A locked axis shows the snap its value comes from, joined to the axis.
      const source = hover.source && toScreen(hover.source.point);
      if (source) {
        svg += line(source, p, LOCK_COLOUR, 1, '2 3');
        svg += marker(hover.source, source);
      }
      svg += hover.locked ? dot(p, LOCK_COLOUR, 5) : marker(hover, p);
      let live = hover.label;
      if (last && state.mode === MEASURE_MODES.DISTANCE) {
        live = `${formatLength(last.point.distanceTo(hover.point))} · ${hover.label}`;
      } else if (state.pending.length === 2 && state.mode === MEASURE_MODES.ANGLE) {
        live = `${formatAngle(angleAt(state.pending[0].point, state.pending[1].point, hover.point))} · ${hover.label}`;
      }
      labels.push({ p: { x: p.x + 14 + live.length * 3.1, y: p.y + 16 }, text: live });
    }
  }

  spreadLabels(labels);
  o.svg.innerHTML = svg;
  o.labels.innerHTML = labels.map((l) => labelHtml(l.text, l.p, l.id, l.lit)).join('');
}

/**
 * Moves an anchored end to where its item now puts it.
 *
 * @param {Object} end
 * @returns {Boolean} whether it moved
 */
function followAnchor(end) {
  const { anchor } = end;
  const placed = anchor && frameOf(anchor.item, frameMatrix);
  if (!placed) return false;
  const point = anchor.local.clone().applyMatrix4(placed);
  if (point.distanceTo(end.point) < MOVED_M) return false;
  end.point.copy(point);
  if (anchor.normal && end.normal) {
    end.normal.copy(anchor.normal).applyMatrix3(normalMatrix.getNormalMatrix(placed)).normalize();
  }
  if (anchor.dir && end.dir) {
    end.dir.copy(anchor.dir).applyMatrix3(new THREE.Matrix3().setFromMatrix4(placed)).normalize();
  }
  return true;
}

/**
 * Brings every measurement up to date with the items its ends are tied to.
 * A throw whose fixture or landing surface moved is measured again.
 *
 * @public
 */
function refresh() {
  state.measurements.forEach((m) => {
    let moved = false;
    m.ends.forEach((end) => { if (followAnchor(end)) moved = true; });
    if (!moved) return;
    if (m.kind === MEASURE_MODES.THROW) {
      const fixture = m.ends[0].anchor && m.ends[0].anchor.item;
      const measured = context && fixture ? throwFrom(fixture) : {};
      if (!measured.ends) return;
      m.ends = markRaw(measured.ends);
      m.values = measured.values;
    } else if (m.kind === MEASURE_MODES.ANGLE) {
      const [a, vertex, c] = m.ends;
      m.values = {
        angle: angleAt(a.point, vertex.point, c.point),
        armA: a.point.distanceTo(vertex.point),
        armC: c.point.distanceTo(vertex.point),
      };
    } else {
      m.values = distanceBetween(m.ends[0], m.ends[1]);
    }
    m.headline = headline(m);
  });
  state.pending.forEach(followAnchor);
}

/**
 * Deletes every measurement with an end tied to an item that is being
 * deleted.
 *
 * @public
 * @param {Object} item a fixture or an object
 */
function forgetItem(item) {
  const raw = toRaw(item);
  const tied = (end) => end.anchor && toRaw(end.anchor.item) === raw;
  if (state.pending.some(tied)) state.pending.splice(0);
  const doomed = state.measurements.filter((m) => m.ends.some(tied)).map((m) => m.id);
  doomed.forEach((id) => remove(id)); // eslint-disable-line no-use-before-define
}

/** Whether any measurement has an end that follows an item. */
function anyAnchored() {
  return state.measurements.some((m) => m.ends.some((end) => end.anchor));
}

/**
 * Whether an end's item, or the structure or group holding it, is selected.
 *
 * @param {Object} end
 * @returns {Boolean}
 */
function onSelection(end) {
  const item = end.anchor && end.anchor.item;
  if (!item) return false;
  return Selection.has(item)
    || (!!item.structure && Selection.has(item.structure))
    || (!!item.group && Selection.has(item.group));
}

/**
 * Whether a measurement is drawn: never when hidden by its own toggle, always
 * while the tool is on, and otherwise as the view filter says.
 *
 * @param {Object} measurement
 * @returns {Boolean}
 */
function isDrawn(measurement) {
  // Selected is always drawn, whatever its own toggle and the filter say.
  if (measurement.id === state.selectedId) return true;
  if (measurement.hidden) return false;
  if (state.active) return true;
  switch (ViewFilter.state.measurements) {
    case MEASURE_FILTERS.NONE: return false;
    case MEASURE_FILTERS.SELECTION: return measurement.ends.some(onSelection);
    default: return true;
  }
}

/**
 * Keeps anchored measurements current every frame, so the widget and the
 * patch sheet read where things are, and draws them while the tool is on or
 * the view filter shows them.
 */
function loop() {
  frame = 0;
  refresh();
  const drawing = state.active || state.selectedId !== null
    || (ViewFilter.state.measurements !== MEASURE_FILTERS.NONE
      && state.measurements.some((m) => !m.hidden));
  if (drawing) {
    draw();
  } else if (overlay && overlay.svg.innerHTML) {
    overlay.svg.innerHTML = '';
    overlay.labels.innerHTML = '';
  }
  if (drawing || anyAnchored()) frame = requestAnimationFrame(loop);
}

function ensureLoop() {
  if (!frame) frame = requestAnimationFrame(loop);
}

ViewFilter.onChange(ensureLoop);

// Items selected from anywhere -- the scene, the item list -- take the place of
// a selected measurement.
watch(() => Selection.items.length, (count) => {
  if (count) state.selectedId = null;
});

/* -------------------------------------------------------------- controls */

/**
 * Connects the tool to the viewport.
 *
 * @public
 * @param {Object} options
 * @param {Function} options.camera returns the camera in use
 * @param {HTMLElement} options.element the canvas
 * @param {Function} options.pickTargets returns the meshes a click can hit
 * @param {Function} options.ownerOfHit the scene item a hit belongs to
 * @param {Function} options.shown whether an item is drawn
 * @param {Function} [options.onActive] told when the tool turns on or off
 */
function attach(options) {
  context = {
    ...options,
    view: {
      element: options.element, camera: options.camera(), width: 1, height: 1,
    },
  };
  options.element.addEventListener('pointerleave', pointerLeave);
  if (!keysBound) {
    keysBound = true;
    window.addEventListener('keydown', modifierKey);
    window.addEventListener('keyup', modifierKey);
  }
}

/**
 * Turns the tool on or off. Measurements stay until cleared.
 *
 * @public
 * @param {Boolean} [on] the state wanted; flips when absent
 */
function toggle(on) {
  const next = on === undefined ? !state.active : !!on;
  if (next === state.active) return;
  state.active = next;
  state.pending.splice(0);
  state.axisLock = null;
  state.message = '';
  hover = null;
  if (context && context.onActive) context.onActive(next);
  ensureLoop();
}

/**
 * @public
 * @param {String} mode one of `MEASURE_MODES`
 */
function setMode(mode) {
  if (!Object.values(MEASURE_MODES).includes(mode)) return;
  state.mode = mode;
  state.pending.splice(0);
  state.axisLock = null;
  state.message = '';
  pointerDirty = true;
}

/** @public */
function clear() {
  const had = state.measurements.length;
  state.measurements.splice(0);
  state.pending.splice(0);
  state.selectedId = null;
  state.hoverId = null;
  state.message = '';
  if (had) notifyChanged();
}

/**
 * @public
 * @param {Number} id
 */
function remove(id) {
  const at = state.measurements.findIndex((m) => m.id === id);
  if (at > -1) {
    state.measurements.splice(at, 1);
    notifyChanged();
  }
  if (state.selectedId === id) state.selectedId = null;
  if (state.hoverId === id) state.hoverId = null;
}

/**
 * Sets what one measurement's label says.
 *
 * @public
 * @param {Number} id
 * @param {Object} settings any of `{ showLength, showAngle, flipAngle }`
 */
function setLabel(id, settings) {
  const measurement = state.measurements.find((m) => m.id === id);
  if (!measurement) return;
  ['showLength', 'showAngle', 'flipAngle'].forEach((key) => {
    if (key in settings) measurement[key] = !!settings[key];
  });
  measurement.headline = headline(measurement);
  notifyChanged();
}

/**
 * Hides or shows one measurement, whatever the view filter says.
 *
 * @public
 * @param {Number} id
 * @param {Boolean} hidden
 */
function setHidden(id, hidden) {
  const measurement = state.measurements.find((m) => m.id === id);
  if (!measurement || !!measurement.hidden === !!hidden) return;
  measurement.hidden = !!hidden;
  notifyChanged();
  ensureLoop();
}

/**
 * Selects a measurement in place of any selected items, or selects none.
 *
 * @public
 * @param {Number|null} id the measurement to select, or null for none
 */
function select(id) {
  state.selectedId = id;
  if (id !== null && context && context.deselectItems) context.deselectItems();
  ensureLoop();
}

/**
 * The measurement whose line passes under the pointer, among those drawn.
 *
 * @public
 * @param {Object} event pointer event in the 3D view
 * @returns {Number|null} its id, or null
 */
function pickAt(event) {
  if (!context) return null;
  updateView(); // eslint-disable-line no-use-before-define
  const rect = context.view.element.getBoundingClientRect();
  const cursor = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
  const a = new THREE.Vector2();
  const b = new THREE.Vector2();
  let best = null;
  let bestDistance = PICK_LINE_PX;
  state.measurements.filter(isDrawn).forEach((m) => { // eslint-disable-line no-use-before-define
    const screens = m.ends.map((end) => toScreen(end.point));
    if (screens.some((s) => !s)) return;
    for (let i = 1; i < screens.length; i += 1) {
      a.set(screens[i - 1].x, screens[i - 1].y);
      b.set(screens[i].x, screens[i].y);
      const ab = b.clone().sub(a);
      const along = ab.lengthSq() ? cursor.clone().sub(a).dot(ab) / ab.lengthSq() : 0;
      const t = THREE.MathUtils.clamp(along, 0, 1);
      const distance = a.clone().addScaledVector(ab, t).distanceTo(cursor);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = m.id;
      }
    }
  });
  return best;
}

/**
 * Puts the selected measurement on the clipboard as its line of text.
 *
 * @public
 * @returns {Boolean} whether a measurement was selected to copy
 */
function copySelected() {
  const measurement = state.measurements.find((m) => m.id === state.selectedId);
  if (!measurement) return false;
  if (navigator.clipboard) navigator.clipboard.writeText(textOf(measurement));
  return true;
}

/**
 * @public
 * @param {Number|null} id the measurement under the pointer in the widget
 */
function hoverRow(id) {
  state.hoverId = id;
}

/**
 * Measurements as a project file holds them: numbers only.
 *
 * @public
 * @returns {Array|undefined} undefined when there are none
 */
function toJSON() {
  if (!state.measurements.length) return undefined;
  refresh();
  const vector = (v) => (v ? [v.x, v.y, v.z] : undefined);
  // The item an end follows, by kind and the id the project saves it under.
  const on = ({ anchor }) => (anchor && anchor.item.id !== undefined ? {
    kind: anchor.item.kind,
    id: anchor.item.id,
    local: vector(anchor.local),
    normal: vector(anchor.normal),
    dir: vector(anchor.dir),
  } : undefined);
  // The label settings, only where they differ from the defaults.
  const unlessDefault = (m, key) => {
    const fallback = labelDefaults(m.kind, m.values)[key];
    return m[key] === fallback ? undefined : m[key];
  };
  return state.measurements.map((m) => ({
    number: m.number,
    kind: m.kind,
    hidden: m.hidden || undefined,
    showLength: unlessDefault(m, 'showLength'),
    showAngle: unlessDefault(m, 'showAngle'),
    flipAngle: m.flipAngle || undefined,
    values: { ...m.values },
    ends: m.ends.map((end) => ({
      point: vector(end.point),
      normal: vector(end.normal),
      dir: vector(end.dir),
      kind: end.kind,
      label: end.label,
      axis: end.axis || undefined,
      on: on(end),
    })),
  }));
}

/**
 * Replaces the measurements with a project's. Entries that do not read as a
 * measurement are skipped. An end whose item cannot be found stays where it
 * was saved.
 *
 * @public
 * @param {Array} [list] as `toJSON` writes it
 * @param {Function} [resolve] `({ kind, id }) => item` for the loaded show
 */
function load(list, resolve = () => null) {
  state.measurements.splice(0);
  state.pending.splice(0);
  state.selectedId = null;
  state.hoverId = null;
  state.message = '';
  const vector = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite)
    ? new THREE.Vector3(a[0], a[1], a[2]) : null);
  (Array.isArray(list) ? list : []).forEach((stored) => {
    if (!stored || !Object.values(MEASURE_MODES).includes(stored.kind)) return;
    const ends = (stored.ends || []).map((end) => {
      if (!end || !vector(end.point)) return null;
      const made = makeEnd({
        point: vector(end.point),
        normal: vector(end.normal),
        dir: vector(end.dir),
        kind: String(end.kind || ''),
        label: String(end.label || ''),
        axis: end.axis,
      });
      const item = end.on && vector(end.on.local) ? resolve(end.on) : null;
      if (item) {
        made.anchor = {
          item,
          local: vector(end.on.local),
          normal: vector(end.on.normal),
          dir: vector(end.on.dir),
        };
      }
      return made;
    });
    const needed = stored.kind === MEASURE_MODES.ANGLE ? 3 : 2;
    if (ends.length !== needed || ends.some((end) => !end)) return;
    const values = {};
    Object.entries(stored.values || {}).forEach(([key, value]) => {
      if (Number.isFinite(value)) values[key] = value;
    });
    // Saved before the angle to +X was kept.
    if (stored.kind !== MEASURE_MODES.ANGLE && values.xAngle === undefined) {
      const xAngle = angleToX(ends[1].point.clone().sub(ends[0].point));
      if (xAngle !== undefined) values.xAngle = xAngle;
    }
    const defaults = labelDefaults(stored.kind, values);
    const setting = (key) => (typeof stored[key] === 'boolean' ? stored[key] : defaults[key]);
    const measurement = {
      id: nextId,
      number: Number.isFinite(stored.number) ? stored.number : state.measurements.length + 1,
      kind: stored.kind,
      hidden: stored.hidden === true,
      showLength: setting('showLength'),
      showAngle: setting('showAngle'),
      flipAngle: stored.flipAngle === true,
      ends: markRaw(ends),
      values,
    };
    nextId += 1;
    measurement.headline = headline(measurement);
    state.measurements.push(measurement);
  });
  ensureLoop(); // eslint-disable-line no-use-before-define
}

/**
 * @public
 * @param {Function} fn called whenever a measurement is added or removed
 */
function onChange(fn) {
  changed = fn;
}

/**
 * The tool's keys. While it is on: Escape steps back out, Delete removes the
 * selected measurement, A switches between distance and angle, and the arrow
 * keys lock an axis. While it is off, Delete removes a selected measurement
 * and Escape deselects it.
 *
 * @public
 * @param {KeyboardEvent} e
 * @returns {Boolean} whether the key was the tool's
 */
function handleKey(e) {
  if (!state.active) {
    if (state.selectedId === null) return false;
    if (e.key === 'Delete') {
      remove(state.selectedId);
      return true;
    }
    // Not consumed: Escape also clears the scene selection.
    if (e.key === 'Escape') state.selectedId = null;
    return false;
  }
  if (e.key === 'Escape') {
    if (state.axisLock) state.axisLock = null;
    else if (state.pending.length) state.pending.splice(0);
    else toggle(false);
    return true;
  }
  if (e.key === 'Delete') {
    if (state.selectedId !== null) remove(state.selectedId);
    return true;
  }
  if (e.key.toLowerCase() === 'a') {
    setMode(state.mode === MEASURE_MODES.ANGLE ? MEASURE_MODES.DISTANCE : MEASURE_MODES.ANGLE);
    return true;
  }
  const axis = AXIS_KEYS[e.key];
  if (axis) {
    e.preventDefault();
    if (state.pending.length) state.axisLock = state.axisLock === axis ? null : axis;
    pointerDirty = true;
    return true;
  }
  return false;
}

export default {
  state,
  attach,
  toggle,
  setMode,
  clear,
  remove,
  select,
  hoverRow,
  toJSON,
  refresh,
  forgetItem,
  setHidden,
  setLabel,
  pickAt,
  copySelected,
  load,
  onChange,
  click,
  pointerMove,
  handleKey,
};
