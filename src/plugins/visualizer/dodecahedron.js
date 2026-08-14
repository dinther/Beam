import * as THREE from 'three';

/**
 * @file A dodecahedron built from 30 one-metre LED bars.
 *
 * Topology, chain order and bar direction are transcribed from the wiring
 * diagram: 20 vertices, 30 edges, run continuously from bar 1 to bar 30.
 *
 * The diagram numbers its bar ends 17 apart (0-16, 17-33, ...), but the bars
 * are 1 m of 60/m strip, so the pixel count here is 60 and addressing is
 * sequential: bar n covers pixels (n-1)*60 to (n-1)*60+59. 1,800 pixels and
 * 5,400 channels, spanning 11 universes.
 *
 * Vertex positions were solved rather than eyeballed: the diagram's adjacency
 * was matched against a true regular dodecahedron by graph isomorphism, so the
 * shape is exact and every edge is 1.000 m.
 */

/** LEDs on each bar: 1 m of 60/m strip. */
const PIXELS_PER_BAR = 60;

/**
 * Vertex positions in metres, flown with the bottom face 3 m above the floor.
 * Edge length is exactly 1 m.
 */
const VERTICES = {
  A: [-0.2629, -0.8090, 3.0000],
  B: [0.6882, -0.5000, 3.0000],
  C: [-0.4253, -1.3090, 3.8507],
  D: [-0.8507, 0.0000, 3.0000],
  E: [-0.2629, 0.8090, 3.0000],
  F: [0.6882, 0.5000, 3.0000],
  G: [1.1135, -0.8090, 3.8507],
  H: [0.4253, -1.3090, 4.3764],
  I: [-1.1135, -0.8090, 4.3764],
  J: [-1.3764, 0.0000, 3.8507],
  K: [-1.1135, 0.8090, 4.3764],
  L: [-0.4253, 1.3090, 3.8507],
  M: [1.1135, 0.8090, 3.8507],
  N: [1.3764, 0.0000, 4.3764],
  O: [0.2629, -0.8090, 5.2270],
  P: [-0.6882, -0.5000, 5.2270],
  Q: [-0.6882, 0.5000, 5.2270],
  R: [0.4253, 1.3090, 4.3764],
  S: [0.8507, 0.0000, 5.2270],
  T: [0.2629, 0.8090, 5.2270],
};

/**
 * The chain, in order. Each entry is the pair of vertices a bar spans, listed
 * start-end so that pixel 0 of that bar sits at the first vertex.
 *
 * The chain is not physically continuous -- it jumps between bars over
 * connecting cable -- which is why the order is transcribed rather than
 * derived.
 */
const BARS = [
  ['A', 'B'], ['B', 'F'], ['F', 'E'], ['E', 'D'], ['D', 'A'],
  ['A', 'C'], ['C', 'H'], ['H', 'G'], ['G', 'B'], ['G', 'N'],
  ['N', 'M'], ['M', 'F'], ['M', 'R'], ['R', 'L'], ['L', 'E'],
  ['L', 'K'], ['K', 'J'], ['J', 'D'], ['J', 'I'], ['I', 'C'],
  ['I', 'P'], ['P', 'O'], ['O', 'H'], ['O', 'S'], ['S', 'N'],
  ['S', 'T'], ['T', 'R'], ['T', 'Q'], ['Q', 'K'], ['Q', 'P'],
];

/** Middle of the shape, so emitters can be pointed outward from it. */
function centroid() {
  const centre = new THREE.Vector3();
  const keys = Object.keys(VERTICES);
  keys.forEach((key) => centre.add(new THREE.Vector3(...VERTICES[key])));
  return centre.divideScalar(keys.length);
}

/**
 * Builds the object into an LED field.
 *
 * @param {Object} field the LEDField module
 * @param {Object} [options]
 * @param {Object} [options.origin] THREE.Vector3 to offset the whole shape by
 * @returns {Object} what was built
 */
function build(field, { origin = new THREE.Vector3() } = {}) {
  const centre = centroid().add(origin);
  const topZ = Math.max(...Object.keys(VERTICES).map((k) => VERTICES[k][2])) + origin.z;
  const midpoint = new THREE.Vector3();

  BARS.forEach(([from, to], index) => {
    const start = new THREE.Vector3(...VERTICES[from]).add(origin);
    const end = new THREE.Vector3(...VERTICES[to]).add(origin);
    midpoint.addVectors(start, end).multiplyScalar(0.5);

    // Emitters point away from the middle, so the object reads as lit from
    // within rather than every bar facing an arbitrary direction.
    const facing = midpoint.clone().sub(centre);

    // The five bars of the top face are aimed down at the ground instead:
    // pointing outward and 45 degrees below horizontal. Detected from the
    // geometry rather than listed by number, so it survives a re-solve.
    const onTopFace = Math.abs(start.z - topZ) < 1e-3 && Math.abs(end.z - topZ) < 1e-3;
    if (onTopFace) {
      facing.z = 0;
      facing.normalize().multiplyScalar(Math.SQRT1_2);
      facing.z = -Math.SQRT1_2;
    }

    field.addBar({
      start,
      end,
      facing,
      pixelCount: PIXELS_PER_BAR,
      firstPixel: index * PIXELS_PER_BAR,
      // Extrusions run corner to corner and meet at the vertices, as built.
      endInset: 0,
      ledInset: 0.025,
    });
  });

  return {
    bars: BARS.length,
    pixels: BARS.length * PIXELS_PER_BAR,
    centre,
  };
}

export default {
  build,
  BARS,
  VERTICES,
  PIXELS_PER_BAR,
  barCount: BARS.length,
  pixelCount: BARS.length * PIXELS_PER_BAR,
};
