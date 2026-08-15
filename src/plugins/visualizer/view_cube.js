import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * @file Navigation cube for the viewport corner.
 *
 * A cube whose faces are named for the view they give: click Top and the
 * camera goes overhead, click a corner for the isometric between three faces.
 * It reads as an object rather than a row of buttons, which is why every CAD
 * package has one -- an icon can only hint at "look from here", a labelled
 * face says it.
 *
 * Adapted from a prototype Paul supplied (viewgizmo.html). Two things carried
 * over because they are better than the obvious approach: the six faces share
 * one texture atlas and hover by shifting its offset rather than redrawing,
 * and a merged copy of the faces is drawn back-side-on behind them, which is
 * what fills the gaps at glancing angles and makes it read as solid.
 *
 * The rounded-rectangle geometry is by @hofk:
 * https://discourse.threejs.org/t/plane-mesh-with-rounded-corners-that-can-have-an-image-texture/46892/2
 */

/** Size of the gizmo's square, in pixels. */
const DIM = 170;

const OPTIONS = {
  resolution: 512,
  cubeBackground: '#2c2e31',
  faceBackground: '#e9edf2',
  textColor: '#1c2126',
  hoverBackground: '#1ca6bd',
  hoverText: '#ffffff',
  circleColor: '#e9edf2',
  circleHoverColor: '#1ca6bd',
  radius: 0.2,
  smoothness: 18,
};

const HALF_PI = Math.PI / 2;

/**
 * The six faces: label, outward normal, and which way is up on the label.
 *
 * Orientation is built from both vectors rather than a single Euler angle. A
 * lone rotation gets the normal right and says nothing about the twist around
 * it, which is how text ends up sideways or upside down -- the prototype
 * dodged this by rotating Back about Y rather than X, a fix that does not
 * survive being remapped from its Y-up world to this Z-up one.
 *
 * The four sides stand upright against world up. Top and Bottom have no such
 * anchor, so they read with Back and Front at the top respectively, which is
 * the usual convention.
 *
 * @constant {Array}
 */
const FACES = [
  {
    label: 'Left', view: 'left', normal: [-1, 0, 0], up: [0, 0, 1],
  },
  {
    label: 'Right', view: 'right', normal: [1, 0, 0], up: [0, 0, 1],
  },
  {
    label: 'Front', view: 'front', normal: [0, -1, 0], up: [0, 0, 1],
  },
  {
    label: 'Back', view: 'back', normal: [0, 1, 0], up: [0, 0, 1],
  },
  {
    label: 'Top', view: 'top', normal: [0, 0, 1], up: [0, 1, 0],
  },
  {
    label: 'Bottom', view: 'bottom', normal: [0, 0, -1], up: [0, -1, 0],
  },
];

/** Reused while orienting the faces. */
const ORIGIN = new THREE.Vector3();
const faceNormal = new THREE.Vector3();
const faceUp = new THREE.Vector3();
const faceBasis = new THREE.Matrix4();

/** The eight corners, pulled in so they sit on the cube's shoulders. */
const CORNERS = [
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1],
  [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map((corner) => corner.map((value) => value * 0.85));

/**
 * Rounded rectangle geometry, by @hofk.
 *
 * @param {Number} w width
 * @param {Number} h height
 * @param {Number} r corner radius
 * @param {Number} s smoothness
 * @returns {Object} THREE.BufferGeometry
 */
function roundedRectangle(w, h, r, s) {
  const wi = w / 2 - r;
  const hi = h / 2 - r;
  const ul = r / w;
  const ur = (w - r) / w;
  const vl = r / h;
  const vh = (h - r) / h;

  const positions = [wi, hi, 0, -wi, hi, 0, -wi, -hi, 0, wi, -hi, 0];
  const uvs = [ur, vh, ul, vh, ul, vl, ur, vl];
  const n = [
    3 * (s + 1) + 3, 3 * (s + 1) + 4, s + 4, s + 5, 2 * (s + 1) + 4, 2,
    1, 2 * (s + 1) + 3, 3, 4 * (s + 1) + 3, 4, 0,
  ];
  const indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]
    .map((i) => n[i]);

  for (let i = 0; i < 4; i++) {
    const xc = i < 1 || i > 2 ? wi : -wi;
    const yc = i < 2 ? hi : -hi;
    const uc = i < 1 || i > 2 ? ur : ul;
    const vc = i < 2 ? vh : vl;

    for (let j = 0; j <= s; j++) {
      const phi = HALF_PI * (i + j / s);
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      positions.push(xc + r * cos, yc + r * sin, 0);
      uvs.push(uc + ul * cos, vc + vl * sin);
      if (j < s) {
        const idx = (s + 1) * i + j + 4;
        indices.push(i, idx, idx + 1);
      }
    }
  }

  return new THREE.BufferGeometry()
    .setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1))
    .setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    .setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
}

/**
 * One canvas holding every face in both states: two columns, plain and
 * hovered, six rows. Hovering then costs a texture offset rather than a
 * redraw.
 *
 * @returns {Object} HTMLCanvasElement
 */
function drawFaceAtlas() {
  const { resolution } = OPTIONS;
  const canvas = document.createElement('canvas');
  canvas.width = resolution * 2;
  canvas.height = resolution * FACES.length;
  const ctx = canvas.getContext('2d');

  const drawState = (x, y, background, foreground, label) => {
    ctx.fillStyle = background;
    ctx.fillRect(x, y, resolution, resolution);
    ctx.fillStyle = foreground;
    ctx.font = `600 ${resolution * 0.2}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + resolution / 2, y + resolution / 2);
  };

  FACES.forEach((face, index) => {
    const y = index * resolution;
    drawState(0, y, OPTIONS.faceBackground, OPTIONS.textColor, face.label);
    drawState(resolution, y, OPTIONS.hoverBackground, OPTIONS.hoverText, face.label);
  });
  return canvas;
}

class ViewCube {
  /**
   * @param {Object} camera the scene camera the cube reflects
   * @param {Object} domElement canvas the gizmo is drawn over
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.hovered = null;

    this.scene = new THREE.Scene();
    // Fixed and perspective, so the cube keeps its own sense of depth however
    // the scene camera is framed.
    this.gizmoCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    // Close enough that the cube and its corner discs nearly fill the square:
    // the corners reach sqrt(3) * 0.85 from the centre, and the visible half
    // height at this distance is a shade more than that.
    this.gizmoCamera.position.set(0, 0, 3.7);

    this.root = new THREE.Object3D();
    this.scene.add(this.root);

    this.planeGeometry = roundedRectangle(2, 2, OPTIONS.radius, OPTIONS.smoothness);
    const atlas = drawFaceAtlas();

    let backdropGeometry = null;
    this.planes = FACES.map((face, index) => {
      const map = new THREE.CanvasTexture(atlas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(0.5, 1 / FACES.length);
      map.offset.set(0, 1 - (index + 1) / FACES.length);
      map.center.set(0, 0);
      map.anisotropy = 16;

      const plane = new THREE.Mesh(this.planeGeometry, new THREE.MeshBasicMaterial({ map }));
      faceNormal.set(face.normal[0], face.normal[1], face.normal[2]);
      faceUp.set(face.up[0], face.up[1], face.up[2]);
      plane.position.copy(faceNormal);
      // lookAt builds a basis whose +Z runs from the target to the eye, and a
      // plane is born facing +Z -- so looking from the normal back at the
      // centre points the face outward, with `up` fixing the twist.
      faceBasis.lookAt(faceNormal, ORIGIN, faceUp);
      plane.quaternion.setFromRotationMatrix(faceBasis);
      plane.userData = { type: 'face', view: face.view };

      // Measured at nearly full size for the backdrop, then shrunk: the
      // backdrop wants to meet at the edges, the faces want a margin.
      plane.scale.setScalar(0.9);
      plane.updateMatrix();
      const contribution = this.planeGeometry.clone().applyMatrix4(plane.matrix);
      backdropGeometry = backdropGeometry
        ? BufferGeometryUtils.mergeGeometries([backdropGeometry, contribution])
        : contribution;
      plane.scale.setScalar(0.72);

      this.root.add(plane);
      return plane;
    });

    this.backdrop = new THREE.Mesh(
      backdropGeometry,
      new THREE.MeshBasicMaterial({ color: OPTIONS.cubeBackground, side: THREE.BackSide }),
    );
    this.root.add(this.backdrop);

    this.circleGeometry = new THREE.CircleGeometry(0.2, 32);
    this.corners = CORNERS.map((corner) => {
      const circle = new THREE.Mesh(
        this.circleGeometry,
        new THREE.MeshBasicMaterial({ color: OPTIONS.circleColor }),
      );
      circle.position.set(corner[0], corner[1], corner[2]);
      // Turned to face outward along its own diagonal.
      circle.lookAt(circle.position.clone().multiplyScalar(2));
      circle.userData = { type: 'corner', direction: circle.position.clone().normalize() };
      this.root.add(circle);
      return circle;
    });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.viewport = new THREE.Vector4();
  }

  /**
   * Turns a pointer event into gizmo-local normalised coordinates.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Boolean} whether the pointer is over the gizmo at all
   */
  locate(event) {
    const rect = this.domElement.getBoundingClientRect();
    const left = rect.left + this.domElement.offsetWidth - DIM;
    const x = (event.clientX - left) / DIM;
    const y = (event.clientY - rect.top) / DIM;
    if (x < 0 || x > 1 || y < 0 || y > 1) return false;
    this.pointer.set(x * 2 - 1, -(y * 2) + 1);
    return true;
  }

  /**
   * Whatever part of the cube the pointer is over.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Object|null} the mesh under the pointer
   */
  pick(event) {
    if (!this.locate(event)) return null;
    this.raycaster.setFromCamera(this.pointer, this.gizmoCamera);
    const hits = this.raycaster.intersectObjects([...this.planes, ...this.corners], false);
    return hits.length ? hits[0].object : null;
  }

  /**
   * Highlights whatever the pointer is over.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Boolean} whether the pointer is over the gizmo
   */
  handlePointerMove(event) {
    const target = this.pick(event);
    if (target === this.hovered) return !!target;
    this.setHovered(this.hovered, false);
    this.setHovered(target, true);
    this.hovered = target;
    return !!target;
  }

  /**
   * Draws one piece in its plain or hovered state.
   *
   * @public
   * @param {Object} mesh piece to change, or null
   * @param {Boolean} state whether it is hovered
   */
  // eslint-disable-next-line class-methods-use-this
  setHovered(mesh, state) {
    if (!mesh) return;
    if (mesh.userData.type === 'face') {
      // The hovered artwork is the atlas's second column.
      mesh.material.map.offset.x = state ? 0.5 : 0;
    } else {
      mesh.material.color.set(state ? OPTIONS.circleHoverColor : OPTIONS.circleColor);
    }
  }

  /**
   * What a click selected.
   *
   * @public
   * @param {Object} event pointer event
   * @returns {Object|null} `{view}` for a face, `{direction}` for a corner
   */
  handleClick(event) {
    const target = this.pick(event);
    if (!target) return null;
    if (target.userData.type === 'face') return { view: target.userData.view };
    return { direction: target.userData.direction.clone() };
  }

  /**
   * Drops any highlight, for when the pointer leaves the canvas entirely.
   *
   * @public
   */
  clearHover() {
    this.setHovered(this.hovered, false);
    this.hovered = null;
  }

  /**
   * Draws the gizmo over the finished image.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   */
  render(renderer) {
    // Turned to match the camera, so a face points at the viewer exactly when
    // looking down that axis.
    this.root.quaternion.copy(this.camera.quaternion).invert();
    this.root.updateMatrixWorld();

    const x = this.domElement.offsetWidth - DIM;
    // Viewport coordinates run from the bottom-left, so the top of the canvas
    // is its height less the gizmo's own size.
    const y = this.domElement.offsetHeight - DIM;

    renderer.getViewport(this.viewport);
    renderer.clearDepth();
    renderer.setViewport(x, y, DIM, DIM);
    renderer.render(this.scene, this.gizmoCamera);
    renderer.setViewport(this.viewport.x, this.viewport.y, this.viewport.z, this.viewport.w);
  }

  /**
   * Releases the textures and geometry.
   *
   * @public
   */
  dispose() {
    this.planes.forEach((plane) => {
      plane.material.map.dispose();
      plane.material.dispose();
    });
    this.corners.forEach((circle) => circle.material.dispose());
    this.planeGeometry.dispose();
    this.circleGeometry.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
  }
}

export default ViewCube;
