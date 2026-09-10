import * as THREE from 'three';

/**
 * @file The geometry of a shape the user built -- cube, cylinder, sphere, plane.
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
export const PRIMITIVE_TYPES = ['cube', 'cylinder', 'sphere', 'plane'];

/**
 * Geometry for a shape the user built, in metres and Z up.
 *
 * Built rather than loaded: a created object is stored as the numbers the user
 * chose, so there is no file to fetch and nothing to correct for.
 *
 * **Every shape stands on its own origin** -- the origin is the middle of its
 * base, and the shape rises from z = 0. A scenic object is placed by where it
 * stands: a Stage Table at z = 0 is on the floor, turning it about the vertical
 * turns it in place, and typing z = 0 in Placement means "on the floor", which
 * is what anyone means by it. Shapes used to be centred on their origin, which
 * put every cube placed at z = 0 half into the floor; only the plane was
 * already built this way, for the same reason.
 *
 * Changed without migrating saved shows (Paul, 2026-09-10): a built shape in a
 * show written before this rises by half its height when reopened.
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
      const height = metre(size.height, 1);
      const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
      // three builds a cylinder around Y; this scene is Z up.
      geometry.rotateX(Math.PI / 2);
      // Standing on its base rather than centred -- see above.
      geometry.translate(0, 0, height / 2);
      return geometry;
    }
    case 'sphere': {
      const radius = metre(size.radius, 0.5);
      const geometry = new THREE.SphereGeometry(radius, 32, 16);
      // Resting on the floor at its lowest point.
      geometry.translate(0, 0, radius);
      return geometry;
    }
    case 'plane': {
      // `PlaneGeometry` lies in XY with its normal along +Z, which in this
      // Z-up scene is already flat and already facing up -- so there is
      // nothing to rotate, and it is left at z = 0 as a floor. (The comment
      // here used to describe standing it up from a Y-up world, which this is
      // not, and a rotation the code has never performed.)
      return new THREE.PlaneGeometry(metre(size.x, 1), metre(size.y, 1));
    }
    case 'cube':
    default: {
      const height = metre(size.z, 1);
      const geometry = new THREE.BoxGeometry(metre(size.x, 1), metre(size.y, 1), height);
      // Standing on its base rather than centred -- see above.
      geometry.translate(0, 0, height / 2);
      return geometry;
    }
  }
}
