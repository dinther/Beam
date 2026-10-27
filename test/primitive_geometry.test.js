/* eslint-disable no-console */
/**
 * Every shape the user can build stands on its own origin.
 *
 * The origin is the middle of the base and the shape rises from z = 0, so a
 * Stage Table placed at z = 0 is on the floor rather than half into it. This
 * pins it for every type, so a shape added later cannot quietly be centred.
 *
 * Usage:
 *   npm test
 */
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import primitiveGeometry, { PRIMITIVE_TYPES as OBJECT_TYPES } from '@/plugins/visualizer/primitive_geometry';
import { BARRIER_KINDS, barrierSize, barrierLayout } from '@/plugins/visualizer/barrier_geometry';
import { splitSurfaces } from '@/plugins/visualizer/geometry_kit';
/**
 * The list the main process validates writes against. Read as text rather than
 * imported: `objectstore.js` pulls in Electron, which will not load here, and
 * the main process cannot import three -- so the two copies of the list are
 * pinned together by this test instead of by an import.
 */
const STORED_TYPES = (() => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/electron/objectstore.js'), 'utf8');
  const match = source.match(/const PRIMITIVE_TYPES = \[([^\]]*)\]/);
  return match ? match[1].split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean) : [];
})();

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Rounded to a micrometre, so float noise from the rotations reads as zero. */
const um = (value) => Math.round(value * 1e6) / 1e6 || 0;

function bounds(primitive) {
  const geometry = primitiveGeometry(primitive);
  geometry.computeBoundingBox();
  return geometry.boundingBox;
}

/** A size for every type that is not the default, so both paths are tested. */
const CUSTOM = {
  cube: { x: 1.8, y: 0.8, z: 0.75 },
  cylinder: { radius: 0.3, height: 2.4 },
  tube: { radius: 0.6, thickness: 0.1, height: 1.5 },
  sphere: { radius: 0.7 },
  plane: { x: 4, y: 3 },
  truss: {
    tubes: 3, width: 0.39, chord: 0.05, brace: 0.025, length: 3,
  },
  drape: { width: 6, drop: 5, fullness: 150 },
  barrier: { kind: 'steel', length: 9 },
};

/** How tall each one should come out, from its own parameters. */
const HEIGHT = {
  cube: (size) => size.z || 1,
  cylinder: (size) => size.height || 1,
  tube: (size) => size.height || 1,
  sphere: (size) => (size.radius || 0.5) * 2,
  plane: () => 0,
  // End plates are on by default and reach one chord diameter past each chord
  // centre: a 0.29 box stands 0.34, a triangle its rise plus two chords.
  truss: (size) => (size.tubes === 3
    ? ((size.width - size.chord) * Math.sqrt(3)) / 2 + 2 * size.chord
    : 0.34),
  drape: (size) => size.drop || 4,
  barrier: (size) => (size.kind === 'steel' ? 1.1 : 1.2),
};

console.log('\n-- the builder and the library agree on what a shape can be --');
check('the library list was found', STORED_TYPES.length > 0, true);
check('same list', OBJECT_TYPES.join(','), STORED_TYPES.join(','));

console.log('\n-- every type the form offers is covered here --');
OBJECT_TYPES.forEach((type) => {
  check(`${type} has a custom size in this test`, !!CUSTOM[type], true);
});

OBJECT_TYPES.forEach((type) => {
  [['default size', {}], ['custom size', CUSTOM[type] || {}]].forEach(([which, size]) => {
    console.log(`\n-- ${type}, ${which} --`);
    const box = bounds({ type, size });
    check('its lowest point is on the floor', um(box.min.z), 0);
    check('and it rises to its own height', um(box.max.z), um(HEIGHT[type](size)));
    check('centred across x', um(box.min.x + box.max.x), 0);
    check('centred across y', um(box.min.y + box.max.y), 0);
  });
});

console.log('\n-- an unknown type falls back to a cube, standing up too --');
{
  const box = bounds({ type: 'teapot', size: {} });
  check('on the floor', um(box.min.z), 0);
  check('a metre tall', um(box.max.z), 1);
}

console.log('\n-- a cylinder stands upright, not on its side --');
{
  // three builds a cylinder around Y; this scene is Z up. Getting the turn
  // wrong would leave it lying down, and lying down it would still sit on the
  // floor -- so the floor check alone would not catch it.
  const box = bounds({ type: 'cylinder', size: { radius: 0.3, height: 2.4 } });
  check('its height is along z', um(box.max.z - box.min.z), 2.4);
  check('its width across x is the diameter', um(box.max.x - box.min.x), 0.6);
}

/**
 * Signed volume of a mesh: positive and equal to the solid's volume only when
 * every face is present and faces outward, which a single-sided material needs.
 */
function signedVolume(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.index.array;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  for (let i = 0; i < index.length; i += 3) {
    a.fromBufferAttribute(pos, index[i]);
    b.fromBufferAttribute(pos, index[i + 1]);
    c.fromBufferAttribute(pos, index[i + 2]);
    volume += a.dot(b.clone().cross(c)) / 6;
  }
  return volume;
}

/** Volumes sum Float32 positions, so they agree to five places, not six. */
const near = (value) => Math.round(value * 1e5) / 1e5;

/** The volume a 32-per-turn polygonal ring section should enclose. */
function polygonVolume(outer, inner, height, degrees) {
  const segments = Math.max(1, Math.ceil((32 * degrees) / 360));
  const step = ((degrees * Math.PI) / 180) / segments;
  return (segments * Math.sin(step) * (outer * outer - inner * inner) * height) / 2;
}

console.log('\n-- arcs are closed, face outward, and are centred on +Y --');
[
  ['full cylinder', { type: 'cylinder', size: { radius: 0.5, height: 1 } }, 0.5, 0, 1, 360],
  ['half cylinder', { type: 'cylinder', size: { radius: 0.5, height: 1, angle: 180 } }, 0.5, 0, 1, 180],
  ['full tube', { type: 'tube', size: { radius: 0.6, thickness: 0.1, height: 1.5 } }, 0.6, 0.5, 1.5, 360],
  ['half tube', {
    type: 'tube',
    size: {
      radius: 0.6, thickness: 0.1, height: 1.5, angle: 180,
    },
  }, 0.6, 0.5, 1.5, 180],
  ['quarter tube', {
    type: 'tube',
    size: {
      radius: 1, thickness: 0.2, height: 2, angle: 90,
    },
  }, 1, 0.8, 2, 90],
  ['270 cylinder', { type: 'cylinder', size: { radius: 1, height: 1, angle: 270 } }, 1, 0, 1, 270],
  ['wall past the axis', { type: 'tube', size: { radius: 0.5, thickness: 2, angle: 120 } }, 0.5, 0, 1, 120],
].forEach(([label, primitive, outer, inner, height, degrees]) => {
  const geometry = primitiveGeometry(primitive);
  check(`${label}: volume`, near(signedVolume(geometry)), near(polygonVolume(outer, inner, height, degrees)));
  const { uv } = geometry.attributes;
  check(`${label}: every vertex has a uv`, !!uv && uv.count === geometry.attributes.position.count, true);
  // UVs are metres: the outer wall runs its arc length round, its height up.
  let around = 0;
  let up = 0;
  for (let i = 0; i < uv.count; i += 1) {
    around = Math.max(around, uv.getX(i));
    up = Math.max(up, uv.getY(i));
  }
  check(`${label}: uv round the wall is its arc length`, near(around), near((outer * degrees * Math.PI) / 180));
  check(`${label}: uv up the wall is its height`, near(up), near(height));
});

console.log('\n-- every built shape has uvs in metres --');
{
  /** How far u and v each range over the whole shape, in uv units. */
  const span = (primitive) => {
    const { uv } = primitiveGeometry(primitive).attributes;
    const u = [Infinity, -Infinity];
    const v = [Infinity, -Infinity];
    for (let i = 0; i < uv.count; i += 1) {
      u[0] = Math.min(u[0], uv.getX(i));
      u[1] = Math.max(u[1], uv.getX(i));
      v[0] = Math.min(v[0], uv.getY(i));
      v[1] = Math.max(v[1], uv.getY(i));
    }
    return { u: u[1] - u[0], v: v[1] - v[0] };
  };
  check('a 3 m cube spans 3 m of uv', near(span({ type: 'cube', size: { x: 3, y: 1, z: 1 } }).u), 3);
  check('a 6 m plane spans 6 m of uv', near(span({ type: 'plane', size: { x: 6, y: 1 } }).u), 6);
  // u carries three's half-segment offset at the poles; v is exact.
  check('a sphere spans pole to pole', near(span({ type: 'sphere', size: { radius: 0.5 } }).v), near(Math.PI / 2));
  OBJECT_TYPES.forEach((type) => {
    const geometry = primitiveGeometry({ type, size: CUSTOM[type] });
    const { uv } = geometry.attributes;
    check(`${type}: every vertex has a uv`, !!uv && uv.count === geometry.attributes.position.count, true);
  });
  const drape = span({
    type: 'drape',
    size: {
      width: 6, drop: 3, fullness: 0, opening: 'single',
    },
  });
  check('a flat 6 m drape runs 6 m of cloth', near(drape.u), 6);
  check('and 3 m of drop', near(drape.v), 3);
}
{
  const box = bounds({
    type: 'tube',
    size: {
      radius: 0.6, thickness: 0.1, height: 1.5, angle: 180,
    },
  });
  check('half tube spans the diameter across x', um(box.max.x - box.min.x), 1.2);
  check('and lies on the +Y side of its axis', um(box.min.y), 0);
  check('out to the radius', um(box.max.y), 0.6);
  check('on the floor', um(box.min.z), 0);
}
{
  const box = bounds({ type: 'cylinder', size: { radius: 0.5, angle: 0 } });
  check('an angle of 0 reads as a full turn', um(box.min.y), -0.5);
}

console.log('\n-- a truss runs along x and stands on the floor, straight or curved --');
{
  const box = bounds({ type: 'truss', size: { length: 3, plates: false } });
  check('without plates a truss is its length along x', um(box.max.x - box.min.x), 3);
  check('and its width across y', um(box.max.y - box.min.y), 0.29);
  check('and its width tall', um(box.max.z), 0.29);
}
{
  const box = bounds({ type: 'truss', size: { length: 3 } });
  check('plates add their thickness at each end', um(box.max.x - box.min.x), 3.02);
  check('and stand a chord diameter wider', um(box.max.y - box.min.y), 0.34);
  check('with the plates on the floor', um(box.min.z), 0);
}
{
  // Every triangle facing out gives a positive volume; a plate turned inside
  // out would take its own volume away.
  const plated = primitiveGeometry({ type: 'truss', size: { shape: 'arc', angle: 90 } });
  const bare = primitiveGeometry({ type: 'truss', size: { shape: 'arc', angle: 90, plates: false } });
  const plates = 4 * 2 * 0.1 * 0.1 * 0.01;
  check('arc plates face out', near(signedVolume(plated) - signedVolume(bare)), near(plates));
}
{
  const size = { length: 3, plateShape: 'round' };
  const box = bounds({ type: 'truss', size });
  check('round plates add their thickness at each end', um(box.max.x - box.min.x), 3.02);
  check('and stand a chord diameter wider', um(box.max.y - box.min.y), 0.34);
  check('on the floor', um(box.min.z), 0);
  const round = primitiveGeometry({ type: 'truss', size: { shape: 'arc', angle: 90, plateShape: 'round' } });
  const bare = primitiveGeometry({ type: 'truss', size: { shape: 'arc', angle: 90, plates: false } });
  // A 32-sided disc of radius 0.05, 10 mm thick, on 4 chords at 2 ends.
  const disc = 16 * Math.sin((2 * Math.PI) / 32) * 0.05 * 0.05 * 0.01;
  check('round arc plates face out', near(signedVolume(round) - signedVolume(bare)), near(8 * disc));
}
[2, 3, 4].forEach((tubes) => {
  ['flat', 'upright'].forEach((ladder) => {
    const box = bounds({
      type: 'truss',
      size: {
        tubes, ladder, shape: 'arc', radius: 2, angle: 120,
      },
    });
    check(`${tubes} chords ${ladder}, arc: on the floor`, um(box.min.z), 0);
  });
});
{
  const box = bounds({ type: 'truss', size: { shape: 'arc', radius: 2, angle: 360 } });
  check('a closed ring is centred across x', um(box.min.x + box.max.x), 0);
  check('and across y', um(box.min.y + box.max.y), 0);
  check('and is 0.29 tall', um(box.max.z), 0.29);
}

console.log('\n-- a drape hangs from its track, folds deepening as it opens --');
{
  const flat = bounds({ type: 'drape', size: { width: 6, fullness: 0 } });
  check('no fullness hangs flat', um(flat.max.y - flat.min.y), 0);
  check('across its width', um(flat.max.x - flat.min.x), 6);
  const raised = bounds({ type: 'drape', size: { drop: 3, gap: 0.5 } });
  check('a floor gap lifts the hem', um(raised.min.z), 0.5);
  check('and the top with it', um(raised.max.z), 3.5);
  const closed = bounds({ type: 'drape', size: { width: 6 } });
  const half = bounds({ type: 'drape', size: { width: 6, open: 50 } });
  check('opening deepens the folds', half.max.y - half.min.y > closed.max.y - closed.min.y, true);
  // A split drape fully open stacks each half into a tenth of its cloth:
  // 3 m of track at 100% fullness is 6 m of cloth, so 0.6 m at each end.
  const open = primitiveGeometry({ type: 'drape', size: { width: 6, open: 100 } });
  const pos = open.attributes.position;
  let inner = Infinity;
  for (let i = 0; i < pos.count; i += 1) inner = Math.min(inner, Math.abs(pos.getX(i)));
  check('fully open, the centre is clear to the stacks', um(inner), 2.4);
  const arc = bounds({ type: 'drape', size: { shape: 'arc', radius: 5, angle: 360 } });
  check('a closed ring of drape is centred', um(arc.min.x + arc.max.x), 0);
}

console.log('\n-- a barrier run: sections whole or stretched, every kind on the floor --');
BARRIER_KINDS.forEach(({ kind, height }) => {
  [false, true].forEach((flip) => {
    const box = bounds({ type: 'barrier', size: { kind, length: 7, flip } });
    const label = `${kind}${flip ? ', flipped' : ''}`;
    check(`${label}: on the floor`, um(box.min.z), 0);
    check(`${label}: its own height`, um(box.max.z), height);
    check(`${label}: centred across y`, um(box.min.y + box.max.y), 0);
    check(`${label}: centred across x`, um(box.min.x + box.max.x), 0);
  });
  const arc = bounds({
    type: 'barrier',
    size: {
      kind, shape: 'arc', length: 12, radius: 6,
    },
  });
  check(`${kind}, arc: on the floor`, um(arc.min.z), 0);
});
{
  const whole = barrierLayout(barrierSize({ kind: 'steel', length: 10 }));
  check('whole: 10 m of 2.3 m sections is 4 of them', whole.count, 4);
  check('coming to 9.2 m', um(whole.run), 9.2);
  const stretch = barrierLayout(barrierSize({ kind: 'steel', length: 10, fit: 'stretch' }));
  check('stretched: 4 sections', stretch.count, 4);
  check('of 2.5 m, filling the 10 m', um(stretch.section), 2.5);
  const short = barrierLayout(barrierSize({ kind: 'fence', length: 1 }));
  check('a run shorter than a section still has one', short.count, 1);
  // Panels butt end to end, so a run of them spans its length exactly.
  const blocks = bounds({ type: 'barrier', size: { kind: 'water', length: 10, fit: 'stretch' } });
  // The end lugs are round about the end pins, so they reach one lug radius
  // past each: 3.57 of the pattern's 64.26 per 2 m section.
  const lugsPast = (2 * 3.57 * 2) / 64.26;
  check('stretched blocks span the run, end lugs past it', um(blocks.max.x - blocks.min.x), um(10 + lugsPast));
  // Pin and knuckle: at a join, one block's low and high lugs and the next
  // block's middle lug stack round the pin with clearance between them.
  const joint = primitiveGeometry({ type: 'barrier', size: { kind: 'water', length: 4 } });
  const pos = joint.attributes.position;
  const heights = new Set();
  const lugRadius = (3.57 * 2) / 64.26;
  for (let i = 0; i < pos.count; i += 1) {
    // The rim of the lugs round the middle join, at the origin.
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    if (Math.abs(r - lugRadius) < 0.003) heights.add(um(pos.getZ(i)));
  }
  const want = [0, 6, 9.05, 19.05, 22.63, 32.14].map((z) => um(z / 32.14));
  check('three lugs stack at the middle join', [...heights].sort((a, b) => a - b).join(','), want.join(','));
}

console.log('\n-- mesh and glass are surfaces of their own, not geometry --');
{
  const names = (size) => {
    const geometry = primitiveGeometry({ type: 'barrier', size });
    return (geometry.userData.surfaces || []).map((s) => s.kind || s.name).join(',');
  };
  check('a fence is frame and mesh', names({ kind: 'fence' }), 'frame,mesh');
  check('a mesh handrail is frame and mesh', names({ kind: 'handrail', infill: 'mesh' }), 'frame,mesh');
  check('a glass handrail is frame and glass', names({ kind: 'handrail', infill: 'glass' }), 'frame,glass');
  check('a steel barrier is frame alone', names({ kind: 'steel' }), 'frame');
  const fence = primitiveGeometry({ type: 'barrier', size: { kind: 'fence', length: 7 } });
  const parts = splitSurfaces(fence);
  check('split into one geometry per surface', parts.length, 2);
  // Two sections of mesh, two triangles each.
  check('the mesh is a sheet per section', parts[1].geometry.index.count / 3, 4);
}

console.log('\n-- feet and posts stand at the joins, square to the sections either side --');
{
  const fence = bounds({ type: 'barrier', size: { kind: 'fence', length: 7 } });
  check('fence feet run 0.7 m across the line', um(fence.max.y - fence.min.y), 0.7);
  check('and 0.22 m along it, half past each end', um(fence.max.x - fence.min.x), 7.22);
  // Three posts on two sections, a 63 mm post at each end.
  const belt = bounds({ type: 'barrier', size: { kind: 'belt', length: 5 } });
  check('a belt run has a post past each end', um(belt.max.x - belt.min.x), um(5 + 0.356));
  // A foot between two sections of an arc points halfway between them: on a
  // run of two, the middle join is at the top of the arc, square to Y.
  const arc = primitiveGeometry({
    type: 'barrier',
    size: {
      kind: 'fence', shape: 'arc', length: 7, radius: 5,
    },
  });
  const pos = arc.attributes.position;
  let tip = -Infinity;
  let tipX = 0;
  for (let i = 0; i < pos.count; i += 1) {
    if (pos.getZ(i) < 0.01 && pos.getY(i) > tip) {
      tip = pos.getY(i);
      tipX = Math.abs(pos.getX(i));
    }
  }
  check('the middle foot lies along the radius', um(tipX) <= 0.11, true);
}

// Guard against the one way this test could pass for the wrong reason.
check('three is the real one', typeof THREE.BoxGeometry, 'function');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
