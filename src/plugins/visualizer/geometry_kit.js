import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * @file Parts for the built shapes -- tubes, boxes, discs, extruded profiles --
 * with UVs in metres.
 *
 * One UV unit is one metre on every face of every built shape, so a material's
 * textures tile at their real size whatever the object's size, and the same
 * material looks the same on a cube, a truss and a barrier.
 */

const UP = new THREE.Vector3(0, 1, 0);
const scratch = {
  direction: new THREE.Vector3(),
  middle: new THREE.Vector3(),
  turn: new THREE.Quaternion(),
  matrix: new THREE.Matrix4(),
  one: new THREE.Vector3(1, 1, 1),
};

/**
 * UVs by projection onto the plane each vertex faces most, in metres. Right
 * for anything with flat faces and their own vertices per face: boxes,
 * extrusions, planes.
 *
 * @param {THREE.BufferGeometry} geometry changed in place
 * @returns {THREE.BufferGeometry} the same geometry
 */
export function projectUVs(geometry) {
  const { position } = geometry.attributes;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const { normal } = geometry.attributes;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i += 1) {
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (ax >= ay && ax >= az) {
      uv[i * 2] = y;
      uv[i * 2 + 1] = z;
    } else if (ay >= az) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * One draw range of an indexed geometry as a geometry of its own.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {Object} group `{ start, count }`
 * @returns {THREE.BufferGeometry}
 */
function groupOf(geometry, group) {
  const source = geometry.index.array.slice(group.start, group.start + group.count);
  // Only the vertices this group uses, renumbered from zero.
  const remap = new Map();
  source.forEach((v) => { if (!remap.has(v)) remap.set(v, remap.size); });
  const part = new THREE.BufferGeometry();
  Object.entries(geometry.attributes).forEach(([name, attribute]) => {
    const size = attribute.itemSize;
    const array = new attribute.array.constructor(remap.size * size);
    remap.forEach((to, from) => {
      for (let k = 0; k < size; k += 1) array[to * size + k] = attribute.array[from * size + k];
    });
    part.setAttribute(name, new THREE.BufferAttribute(array, size, attribute.normalized));
  });
  part.setIndex(Array.from(source, (v) => remap.get(v)));
  return part;
}

/**
 * A merged geometry as one geometry per surface, each with its spec. One with
 * no surfaces comes back whole, as the shape's own surface.
 *
 * @param {THREE.BufferGeometry} geometry from `Parts.merge`, or any
 * @returns {Array} `{ geometry, spec }`
 */
export function splitSurfaces(geometry) {
  const surfaces = geometry.userData && geometry.userData.surfaces;
  if (!surfaces || geometry.groups.length < 2) {
    return [{ geometry, spec: (surfaces && surfaces[0]) || {} }];
  }
  const out = geometry.groups.map((group) => ({
    geometry: groupOf(geometry, group),
    spec: surfaces[group.materialIndex],
  }));
  geometry.dispose();
  return out;
}

/**
 * A collection of parts, merged into one geometry at the end.
 *
 * Parts are sorted into surfaces, each drawn with its own material: `frame`
 * unless `use` says otherwise. The merged geometry has one group per surface,
 * in the order they were first used, and lists them in `userData.surfaces`.
 */
export class Parts {
  constructor() {
    /** Surface name to its spec and its parts. */
    this.surfaces = new Map();
    this.use('frame');
  }

  /**
   * Sends the parts that follow to a surface.
   *
   * @param {String} name
   * @param {Object} [spec] what the material is, `{ kind, ... }`; see
   *   `scene_objects.surfaceMaterial`
   * @returns {Parts} this
   */
  use(name, spec = {}) {
    if (!this.surfaces.has(name)) this.surfaces.set(name, { spec: { name, ...spec }, list: [] });
    this.list = this.surfaces.get(name).list;
    return this;
  }

  /**
   * Adds a geometry as it is. One merged from other parts keeps its surfaces.
   *
   * @param {THREE.BufferGeometry} geometry
   */
  add(geometry) {
    const surfaces = geometry.userData && geometry.userData.surfaces;
    if (!surfaces || !geometry.groups.length) {
      this.list.push(geometry);
      return;
    }
    const current = this.list;
    geometry.groups.forEach((group) => {
      const { name, ...spec } = surfaces[group.materialIndex];
      this.use(name, spec);
      this.list.push(groupOf(geometry, group));
    });
    geometry.dispose();
    this.list = current;
  }

  /**
   * A round tube between two points: round its side the UVs run its
   * circumference, along it its length, and its ends are projected.
   *
   * @param {THREE.Vector3} a
   * @param {THREE.Vector3} b
   * @param {Number} radius metres
   * @param {Object} [options] `{ sides = 12, open = false }`; open leaves the
   *   ends off, for a tube whose ends are buried in something else
   */
  tube(a, b, radius, { sides = 12, open = false } = {}) {
    const {
      direction, middle, turn, matrix,
    } = scratch;
    direction.subVectors(b, a);
    const length = direction.length();
    if (length < 1e-5) return;
    const geometry = new THREE.CylinderGeometry(radius, radius, length, sides, 1, open);
    const { position } = geometry.attributes;
    const { normal } = geometry.attributes;
    const { uv } = geometry.attributes;
    for (let i = 0; i < uv.count; i += 1) {
      if (Math.abs(normal.getY(i)) > 0.5) {
        uv.setXY(i, position.getX(i), position.getZ(i));
      } else {
        uv.setXY(i, uv.getX(i) * 2 * Math.PI * radius, (position.getY(i) + length / 2));
      }
    }
    turn.setFromUnitVectors(UP, direction.divideScalar(length));
    middle.addVectors(a, b).multiplyScalar(0.5);
    geometry.applyMatrix4(matrix.compose(middle, turn, scratch.one));
    this.list.push(geometry);
  }

  /**
   * A round tube bent along a circular arc, its UVs along it and round it in
   * metres. The arc is in the plane of `u` and `v` about `centre`: the point
   * at angle a is centre + bend (u cos a + v sin a).
   *
   * @param {THREE.Vector3} centre
   * @param {THREE.Vector3} u unit vector, angle 0
   * @param {THREE.Vector3} v unit vector, angle 90 degrees
   * @param {Number} bend radius of the bend to the tube's centre line
   * @param {Number} from start angle, radians
   * @param {Number} to end angle, radians
   * @param {Number} radius tube radius
   * @param {Object} [options] `{ sides = 12, segments = 8 }`
   */
  bend(centre, u, v, bend, from, to, radius, { sides = 12, segments = 8 } = {}) {
    const curve = new THREE.Curve();
    curve.getPoint = (t, target = new THREE.Vector3()) => {
      const a = from + (to - from) * t;
      return target.copy(centre)
        .addScaledVector(u, bend * Math.cos(a))
        .addScaledVector(v, bend * Math.sin(a));
    };
    const geometry = new THREE.TubeGeometry(curve, segments, radius, sides, false);
    const along = bend * Math.abs(to - from);
    const { uv } = geometry.attributes;
    for (let i = 0; i < uv.count; i += 1) {
      uv.setXY(i, uv.getX(i) * along, uv.getY(i) * 2 * Math.PI * radius);
    }
    this.list.push(geometry);
  }

  /**
   * A box, its UVs projected, turned and placed.
   *
   * @param {Number} sx size along its own x, metres
   * @param {Number} sy
   * @param {Number} sz
   * @param {THREE.Matrix4} [placement] where it goes; its centre is its origin
   */
  box(sx, sy, sz, placement) {
    const geometry = projectUVs(new THREE.BoxGeometry(sx, sy, sz));
    if (placement) geometry.applyMatrix4(placement);
    this.list.push(geometry);
  }

  /**
   * A box between two corners, square to the axes.
   *
   * @param {Number} x0
   * @param {Number} y0
   * @param {Number} z0
   * @param {Number} x1
   * @param {Number} y1
   * @param {Number} z1
   */
  block(x0, y0, z0, x1, y1, z1) {
    this.box(
      Math.abs(x1 - x0),
      Math.abs(y1 - y0),
      Math.abs(z1 - z0),
      new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
    );
  }

  /**
   * A flat disc facing +Z before placement, its UVs its own position.
   *
   * @param {Number} radius
   * @param {Number} sides
   * @param {THREE.Matrix4} [placement]
   */
  disc(radius, sides, placement) {
    const geometry = new THREE.CircleGeometry(radius, sides);
    const { position } = geometry.attributes;
    const { uv } = geometry.attributes;
    for (let i = 0; i < uv.count; i += 1) uv.setXY(i, position.getX(i), position.getY(i));
    if (placement) geometry.applyMatrix4(placement);
    this.list.push(geometry);
  }

  /**
   * A flat panel with no thickness in the XZ plane at `y`, facing -Y, for a
   * surface whose material draws both sides.
   *
   * @param {Number} x0
   * @param {Number} z0
   * @param {Number} x1
   * @param {Number} z1
   * @param {Number} [y]
   */
  sheet(x0, z0, x1, z1, y = 0) {
    const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(Math.PI / 2);
    geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.list.push(projectUVs(geometry));
  }

  /**
   * A profile in the YZ plane extruded along X, from x0 to x1: a cross section
   * swept the length of a block. Flat shaded and projected.
   *
   * @param {Array} profile `[y, z]` points, anticlockwise seen from +X
   * @param {Number} x0
   * @param {Number} x1
   * @param {THREE.Matrix4} [placement]
   */
  extrude(profile, x0, x1, placement, holes = []) {
    const shape = new THREE.Shape(profile.map(([y, z]) => new THREE.Vector2(y, z)));
    holes.forEach((hole) => {
      shape.holes.push(new THREE.Path(hole.map(([y, z]) => new THREE.Vector2(y, z))));
    });
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false });
    // Extruded along +Z from the profile in XY; turned so the profile lies in
    // YZ and the length runs along +X.
    geometry.applyMatrix4(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    ));
    geometry.translate(x0, 0, 0);
    // ExtrudeGeometry gives every triangle its own vertices, so the normals
    // and the projection come out flat on every face.
    geometry.computeVertexNormals();
    projectUVs(geometry);
    if (placement) geometry.applyMatrix4(placement);
    this.list.push(geometry);
  }

  /**
   * A plan outline in XY swept straight up from z0 to z1, with holes.
   *
   * @param {Array} outline `[x, y]` points, anticlockwise seen from above
   * @param {Number} z0
   * @param {Number} z1
   * @param {Array} [holes] each an array of `[x, y]` points
   */
  prism(outline, z0, z1, holes = []) {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    holes.forEach((hole) => {
      shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    });
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
    geometry.translate(0, 0, z0);
    geometry.computeVertexNormals();
    this.list.push(projectUVs(geometry));
  }

  /**
   * A solid between closed plan outlines at rising heights: each ring is
   * `[x, y, z]` points, anticlockwise seen from above, all rings the same
   * length. Sides join each ring to the next; the lowest ring is capped below
   * and, with `top`, the highest above. A ring may pinch to a line or a point.
   *
   * @param {Array} rings
   * @param {Object} [options] `{ top = false }`
   */
  loft(rings, { top = false } = {}) {
    const positions = [];
    const triangle = (a, b, c) => {
      const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      if (ab.cross(ac).lengthSq() < 1e-14) return;
      positions.push(...a, ...b, ...c);
    };
    for (let k = 0; k < rings.length - 1; k += 1) {
      const p = rings[k];
      const q = rings[k + 1];
      for (let i = 0; i < p.length; i += 1) {
        const j = (i + 1) % p.length;
        triangle(p[i], p[j], q[j]);
        triangle(p[i], q[j], q[i]);
      }
    }
    const cap = (ring, up) => {
      const flat = ring.map(([x, y]) => new THREE.Vector2(x, y));
      // Wound by the normal it comes out with, which triangulation does not fix.
      THREE.ShapeUtils.triangulateShape(flat, []).forEach(([a, b, c]) => {
        const [pa, pb, pc] = [flat[a], flat[b], flat[c]];
        const facesUp = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y) > 0;
        if (facesUp === up) triangle(ring[a], ring[b], ring[c]);
        else triangle(ring[a], ring[c], ring[b]);
      });
    };
    cap(rings[0], false);
    if (top) cap(rings[rings.length - 1], true);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    this.list.push(projectUVs(geometry));
  }

  /**
   * Everything added, as one indexed geometry with position, normal and uv:
   * one group per surface that has parts, listed in `userData.surfaces`.
   *
   * @returns {THREE.BufferGeometry}
   */
  merge() {
    const prepare = (geometry) => {
      let part = geometry;
      part.clearGroups();
      if (!part.index) {
        const { count } = part.attributes.position;
        part.setIndex(Array.from({ length: count }, (_, i) => i));
      }
      if (!part.attributes.normal) part.computeVertexNormals();
      Object.keys(part.attributes).forEach((name) => {
        if (!['position', 'normal', 'uv'].includes(name)) part.deleteAttribute(name);
      });
      part = part.attributes.uv ? part : projectUVs(part);
      return part;
    };
    const specs = [];
    const bodies = [];
    this.surfaces.forEach(({ spec, list }) => {
      if (!list.length) return;
      const ready = list.map(prepare);
      bodies.push(ready.length === 1 ? ready[0] : mergeGeometries(ready, false));
      if (ready.length > 1) ready.forEach((part) => part.dispose());
      specs.push(spec);
    });
    if (!bodies.length) return new THREE.BufferGeometry();
    const merged = mergeGeometries(bodies, true);
    bodies.forEach((body) => body.dispose());
    merged.userData.surfaces = specs;
    return merged;
  }
}
