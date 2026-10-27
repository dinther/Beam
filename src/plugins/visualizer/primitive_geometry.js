import * as THREE from 'three';
import trussGeometry from './truss_geometry';
import drapeGeometry from './drape_geometry';
import barrierGeometry from './barrier_geometry';
import { projectUVs } from './geometry_kit';

/**
 * @file The geometry of a shape the user built -- cube, cylinder, tube, sphere,
 * plane, truss, drape, barrier.
 *
 * Its own module because it is a pure function of three and nothing else,
 * where `scene_objects.js` pulls in the scene and the glTF loaders. That is
 * what lets a test load it and pin the one rule every shape has to keep.
 */

/**
 * The shapes this can build, in the order the create form offers them.
 *
 * Here, beside the code that builds them, so a shape cannot be offered that
 * nothing builds or built without being offered. `objectstore.js` keeps its own
 * copy to validate what it writes, because the main process cannot import
 * three; the test pins the two together.
 *
 * @constant {Array}
 */
export const PRIMITIVE_TYPES = ['cube', 'cylinder', 'tube', 'sphere', 'plane', 'truss', 'drape', 'barrier'];

/**
 * Segments in a full turn of a cylinder or tube. A partial arc keeps the same
 * density, so a half tube is as smooth as a whole one.
 *
 * @constant {Number}
 */
const SEGMENTS_PER_TURN = 32;

/**
 * The swept angle of a cylinder or tube, in degrees, between 1 and 360.
 * Missing means a full turn, which is what every shape saved before the angle
 * existed was.
 *
 * @param {*} value
 * @returns {Number}
 */
export function arcDegrees(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 360;
  return Math.min(Math.max(number, 1), 360);
}

/**
 * A closed solid swept about Z: a ring section between two radii, rising from
 * z = 0 to the height.
 *
 * An inner radius of 0 makes a cylinder, anything larger a tube. Below a full
 * turn the cut is closed with end faces -- created objects are single sided,
 * so an open cut would show straight through the shape. The arc is centred on
 * +Y, so the axis stays at the origin and changing the angle trims both ends
 * evenly.
 *
 * Each face has its own vertices, so computed normals are smooth round the
 * walls and flat on the caps and ends. UVs are in metres: round the arc and
 * up the height on the walls, the plan position on the caps, out from the
 * axis and up the height on the ends.
 *
 * @param {Number} outer radius in metres
 * @param {Number} inner radius in metres, 0 for a solid cylinder
 * @param {Number} height in metres
 * @param {Number} degrees swept angle
 * @returns {THREE.BufferGeometry}
 */
function arcSolid(outer, inner, height, degrees) {
  const sweep = (degrees * Math.PI) / 180;
  const full = degrees >= 360;
  const segments = Math.max(1, Math.ceil((SEGMENTS_PER_TURN * degrees) / 360));
  const start = Math.PI / 2 - sweep / 2;
  const hollow = inner > 0;

  const positions = [];
  const uvs = [];
  const indices = [];
  const vertex = (x, y, z, u, v) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    return positions.length / 3 - 1;
  };
  const angleAt = (i) => start + (sweep * i) / segments;

  // A wall round the arc at one radius, facing out or in.
  const wall = (radius, outward) => {
    const first = positions.length / 3;
    for (let i = 0; i <= segments; i += 1) {
      const a = angleAt(i);
      const x = radius * Math.cos(a);
      const y = radius * Math.sin(a);
      const around = (radius * sweep * i) / segments;
      vertex(x, y, 0, around, 0);
      vertex(x, y, height, around, height);
    }
    for (let i = 0; i < segments; i += 1) {
      const b0 = first + i * 2;
      const t0 = b0 + 1;
      const b1 = b0 + 2;
      const t1 = b0 + 3;
      if (outward) indices.push(b0, b1, t1, b0, t1, t0);
      else indices.push(b0, t1, b1, b0, t0, t1);
    }
  };

  // A cap across the ring at one height, facing up or down.
  const cap = (z, up) => {
    const first = positions.length / 3;
    const planar = (x, y) => [x, y];
    for (let i = 0; i <= segments; i += 1) {
      const a = angleAt(i);
      const ix = inner * Math.cos(a);
      const iy = inner * Math.sin(a);
      const ox = outer * Math.cos(a);
      const oy = outer * Math.sin(a);
      vertex(ix, iy, z, ...planar(ix, iy));
      vertex(ox, oy, z, ...planar(ox, oy));
    }
    for (let i = 0; i < segments; i += 1) {
      const in0 = first + i * 2;
      const out0 = in0 + 1;
      const in1 = in0 + 2;
      const out1 = in0 + 3;
      if (up) {
        indices.push(in0, out0, out1);
        // With no hole the inner edge is a point, and this half is empty.
        if (hollow) indices.push(in0, out1, in1);
      } else {
        indices.push(in0, out1, out0);
        if (hollow) indices.push(in0, in1, out1);
      }
    }
  };

  // A flat end closing the cut at one end of the arc.
  const end = (a, atStart) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ib = vertex(inner * c, inner * s, 0, inner, 0);
    const ob = vertex(outer * c, outer * s, 0, outer, 0);
    const ot = vertex(outer * c, outer * s, height, outer, height);
    const it = vertex(inner * c, inner * s, height, inner, height);
    if (atStart) indices.push(ib, ob, ot, ib, ot, it);
    else indices.push(ib, ot, ob, ib, it, ot);
  };

  wall(outer, true);
  if (hollow) wall(inner, false);
  cap(height, true);
  cap(0, false);
  if (!full) {
    end(angleAt(0), true);
    end(angleAt(segments), false);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Geometry for a shape the user built, in metres and Z up, with UVs in metres
 * so a material's textures tile at their real size on every shape.
 *
 * Built rather than loaded: a created object is stored as the numbers the user
 * chose, so there is no file to fetch and nothing to correct for.
 *
 * **Every shape stands on its own origin** -- the origin is the middle of its
 * base, and the shape rises from z = 0. A scenic object is placed by where it
 * stands: a Stage Table at z = 0 is on the floor, turning it about the vertical
 * turns it in place, and typing z = 0 in Placement means "on the floor", which
 * is what anyone means by it. A shape centred on its origin would sit half
 * into the floor at z = 0.
 *
 * @param {Object} primitive `{ type, size }` from the descriptor
 * @returns {THREE.BufferGeometry}
 */
export default function primitiveGeometry(primitive) {
  const size = primitive.size || {};
  const metre = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };

  switch (primitive.type) {
    case 'cylinder': {
      const radius = metre(size.radius, 0.5);
      return arcSolid(radius, 0, metre(size.height, 1), arcDegrees(size.angle));
    }
    case 'tube': {
      const radius = metre(size.radius, 0.5);
      // A wall as thick as the radius or thicker leaves no hole: a cylinder.
      const inner = Math.max(radius - metre(size.thickness, 0.05), 0);
      return arcSolid(radius, inner, metre(size.height, 1), arcDegrees(size.angle));
    }
    case 'sphere': {
      const radius = metre(size.radius, 0.5);
      const geometry = new THREE.SphereGeometry(radius, 32, 16);
      // Metres round the equator and from pole to pole.
      const { uv } = geometry.attributes;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setXY(i, uv.getX(i) * 2 * Math.PI * radius, uv.getY(i) * Math.PI * radius);
      }
      // Resting on the floor at its lowest point.
      geometry.translate(0, 0, radius);
      return geometry;
    }
    case 'plane': {
      // `PlaneGeometry` lies in XY with its normal along +Z, which in this
      // Z-up scene is already flat and already facing up -- so there is
      // nothing to rotate, and it is left at z = 0 as a floor.
      return projectUVs(new THREE.PlaneGeometry(metre(size.x, 1), metre(size.y, 1)));
    }
    case 'truss':
      return trussGeometry(size);
    case 'drape':
      return drapeGeometry(size);
    case 'barrier':
      return barrierGeometry(size);
    case 'cube':
    default: {
      const height = metre(size.z, 1);
      const geometry = new THREE.BoxGeometry(metre(size.x, 1), metre(size.y, 1), height);
      // Standing on its base rather than centred -- see above.
      geometry.translate(0, 0, height / 2);
      return projectUVs(geometry);
    }
  }
}
