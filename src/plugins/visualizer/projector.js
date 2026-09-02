import * as THREE from 'three';
import SceneManager from './scene_manager';
import { PROJECTOR_NEAR, PROJECTOR_FAR } from './projector_depth';
import {
  lensOrigin, throwAngles, throwFrustum, throwRange,
} from '../../models/DMX/generic/projector';

/**
 * @file Renderer for a generic projector: a box with a barrel on its front.
 *
 * Deliberately the simplest thing that reads as a projector from across a room,
 * because that is all a projector has to be here -- the interesting part is
 * where its image lands, not what the chassis looks like. A cube and a cylinder
 * driven from the profile's own numbers cover the shapes real machines come in
 * far better than one model would, and the same argument that made the profile
 * generic makes the geometry generic too.
 *
 * Nothing here is instanced, unlike the head and the bar. A rig has a handful
 * of projectors where it has two hundred movers, so two draws each is not worth
 * the fixed capacity, the growth logic and the whole class of bug that the
 * hundred-mover ceiling was. Shared unit geometries scaled per instance give
 * most of the saving anyway: no projector allocates geometry of its own except
 * its frustum, which is sixteen vertices.
 *
 * **Local axes: +Z is up and the throw runs along -Y.** So a projector at zero
 * rotation stands on its feet and faces the scene's Front, which the view cube
 * defines as `normal: [0,-1,0]` -- you see its lens rather than its back, and a
 * new one is aimed the way an audience sits rather than at the ceiling.
 *
 * The bar's +Z is *up*, not "wherever the light goes": it lies flat and emits
 * from its upper face, so the two coincide there and only there. Reading that
 * as a rule and giving the projector a +Z throw is exactly how it ended up
 * pointing at the ceiling once.
 */

/** Every projector in the scene, so the statics can sweep them. */
const instances = new Set();

/** Unit body, scaled per projector. */
const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/**
 * Unit barrel.
 *
 * A cylinder already stands on Y, which is the axis the throw runs along, so
 * nothing has to be turned.
 */
// Open at both ends. The front is closed by a ring with the glass set into it,
// so no face sits directly behind the glass to fight with it; the back is
// covered by the body's own front panel, which the barrel meets flush.
const BARREL_GEOMETRY = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1, true);

/**
 * The housing around the glass: the barrel's front, with a hole in it.
 *
 * Inner radius matches the glass, so the two meet at an edge instead of
 * overlapping. The ratio is fixed, so this scales with the barrel.
 */
const RING_GEOMETRY = new THREE.RingGeometry(0.41, 0.5, 24);
RING_GEOMETRY.rotateX(Math.PI / 2);

/** The glass. A circle faces +Z, and the lens faces -Y, so it is turned once. */
const GLASS_GEOMETRY = new THREE.CircleGeometry(0.5, 24);
GLASS_GEOMETRY.rotateX(Math.PI / 2);

/**
 * A light grey chassis, and deliberately not the near-black every other fixture
 * wears.
 *
 * Two reasons, and they agree. **It is what projectors look like**: movers are
 * black because they hide in a dark rig, while install projectors are mostly
 * white or light grey because they hide against a ceiling. And **it is the only
 * way one reads at all**: a mover is legible in a black room because it throws
 * a beam, where a projector showing nothing has only its silhouette, and a dark
 * box on a `#0C0D0A` background has no silhouette. A palette grey was tried
 * first and disappeared -- a lit material in an unlit room reflects nothing, so
 * the colour has to carry it.
 *
 * The small `emissive` is a floor, not a glow: it stops the unlit faces going
 * to absolute black while leaving the lit ones free to shade normally, so the
 * box still reads as a box rather than as a flat grey card.
 */
const BODY_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xa8aeb4,
  emissive: 0x767d84,
  roughness: 0.9,
  metalness: 0.05,
});

/** The barrel, much darker, because a lens housing is. */
const BARREL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x2a2d30,
  emissive: 0x303437,
  roughness: 0.45,
  metalness: 0.3,
});

/**
 * The glass, unlit on purpose.
 *
 * `MeshBasicMaterial` ignores scene lighting, so the one part that says which
 * way a projector is pointing is legible in a black room with nothing switched
 * on -- which is exactly the scene someone is in when they have just made one.
 * The teal is the same accent the create dialog draws the lens in, so the
 * drawing and the thing in the scene agree.
 */
const GLASS_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x1ca6bd });

/** Outline shown while a projector is selected. Matches the bar's. */
const HIGHLIGHT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1ca6bd });

/** The throw, drawn only while selected -- see `showAids`. */
const FRUSTUM_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x1ca6bd,
  transparent: true,
  opacity: 0.45,
});

/**
 * How far the frustum is drawn, in metres.
 *
 * An aid, not a measurement: a projector's cone carries on until it hits
 * something, and until there is a depth map per projector nothing here knows
 * where that is. Long enough to show which way the machine is aimed and how
 * wide it opens, short enough not to fill the scene with teal.
 */
const FRUSTUM_LENGTH = 8;

const DEG2RAD = Math.PI / 180;

/** Scratch box, reused while growing a selection box. */
const bodyBounds = new THREE.Box3();

class Projector {
  /**
   * @param {Object} data
   * @param {Object} data.params projector parameters, see the generic model
   * @param {Function} [data.settingsAt] () => the placement's ProjectorSettings
   */
  constructor(data = {}) {
    this._params = data.params || {};
    // A getter rather than the object, so the panel can edit settings in place
    // and this sees the new value on the next refresh without being re-handed
    // anything. Null for a projector built without a placement behind it.
    this._settingsAt = data.settingsAt || (() => null);
    this._connectorAt = data.connectorAt || (() => null);
    // The lens as a camera: what it can see is what it lights. Plain rather
    // than a PerspectiveCamera because the frustum is asymmetric -- lens shift
    // is an off-centre projection, and `fov` cannot say that.
    this._camera = new THREE.Camera();
    // The lens transform is composed by hand from the fixture's world matrix
    // and the lens offset, so three must not recompute it: `render` calls
    // `updateMatrixWorld` on a parentless camera, which would rebuild the
    // matrix from an untouched position and quaternion and quietly render the
    // depth atlas from the world origin.
    this._camera.matrixWorldAutoUpdate = false;
    this._lensMatrix = new THREE.Matrix4();
    this._basis = new THREE.Matrix4().makeBasis(
      // A three camera looks down -Z with +Y up; a projector throws along -Y
      // with +Z up. Writing the camera's axes in the fixture's own frame is the
      // whole of the conversion -- and its right comes out as the fixture's
      // -X, which is what keeps the picture from being mirrored.
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 1, 0),
    );
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this.unsupported = false;
    this.fixtureHandle = null;
    this._highlighted = false;

    // The transform node the gizmo and the bounding box attach to. Every
    // renderer has to offer one; it is how selection knows where a fixture is.
    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    // Both solid parts are pickable. A barrel sticking a long way out of a
    // shallow body is most of what you can see of some projectors, and a pick
    // that only tested the box would miss it.
    this._body = new THREE.Mesh(BOX_GEOMETRY, BODY_MATERIAL);
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);

    this._barrel = new THREE.Mesh(BARREL_GEOMETRY, BARREL_MATERIAL);
    this._barrel.userData.pickOwner = this;
    this._dummy.add(this._barrel);

    this._ring = new THREE.Mesh(RING_GEOMETRY, BARREL_MATERIAL);
    this._ring.userData.pickOwner = this;
    this._dummy.add(this._ring);

    this._glass = new THREE.Mesh(GLASS_GEOMETRY, GLASS_MATERIAL);
    this._dummy.add(this._glass);

    this._outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(BOX_GEOMETRY),
      HIGHLIGHT_MATERIAL,
    );
    this._outline.visible = false;
    this._dummy.add(this._outline);

    this._frustum = new THREE.LineSegments(new THREE.BufferGeometry(), FRUSTUM_MATERIAL);
    this._frustum.visible = false;
    this._dummy.add(this._frustum);

    this.applyGeometry();
    instances.add(this);
  }

  /**
   * Sizes every part from the profile's numbers.
   *
   * Called once at construction today. It is a method rather than inline
   * because editing a projector's body is the obvious next thing to want, and
   * the whole point of a parametric model is that it can be re-read.
   *
   * @public
   */
  applyGeometry() {
    const params = this._params || {};
    // Guarded because these come from a form: a field mid-edit can be zero, and
    // a zero scale collapses a mesh to a plane that then fails to raycast.
    const width = Math.max(Number(params.width) || 0, 0.001);
    const height = Math.max(Number(params.height) || 0, 0.001);
    const depth = Math.max(Number(params.depth) || 0, 0.001);
    const diameter = Math.max(Number(params.lensDiameter) || 0, 0.001);
    const protrusion = Math.max(Number(params.lensProtrusion) || 0, 0.001);

    // Width across, depth front-to-back, height up -- the box stands the way
    // the machine does.
    this._body.scale.set(width, depth, height);
    this._outline.scale.copy(this._body.scale);

    // The model measures the lens from the centre of the front panel, seen by
    // someone facing it. The panel faces -Y, so that observer stands at -Y and
    // looks towards +Y, and with +Z up they have +X on their right -- so both
    // numbers land on their own axes and neither is negated. See the note in
    // the model, which this settles.
    const lens = lensOrigin(params);

    this._barrel.scale.set(diameter, protrusion, diameter);
    this._barrel.position.set(lens.x, -(depth / 2 + protrusion / 2), lens.z);

    // The barrel's front is a ring, and the glass is set a little way back
    // inside it -- so the glass reads as glass in a housing, and nothing sits
    // behind it to punch through at distance. It used to float 1.5 mm proud of
    // a solid cap, which holds until depth resolution coarsens with distance
    // and the two land in the same bucket.
    this._ring.scale.set(diameter, 1, diameter);
    this._ring.position.set(lens.x, lens.y, lens.z);

    this._glass.scale.set(diameter * 0.82, 1, diameter * 0.82);
    this._glass.position.set(lens.x, lens.y + Math.min(diameter * 0.06, protrusion * 0.25), lens.z);

    this.buildFrustum(lens);
  }

  /**
   * Re-reads the placement's settings and redraws the throw.
   *
   * Called when a field changes and when a channel writes, which for a
   * projector is the same event seen from two sides.
   *
   * @public
   */
  refresh() {
    this.buildFrustum(lensOrigin(this._params || {}));
  }

  /**
   * Rebuilds the wireframe cone from the lens.
   *
   * Drawn at the placement's own zoom, falling back to the **wide** end when
   * there is no placement -- that is the envelope, the most the projector can
   * cover from where it stands, which is the question being asked while aiming
   * one.
   *
   * Lens shift moves the picture without moving the machine, so it offsets the
   * far rectangle and leaves the apex alone. That skew is exactly what shift
   * looks like in the room, and drawing it any other way would make the cone
   * disagree with the image once one lands.
   *
   * @public
   * @param {Object} lens `{ x, y, z }` from `lensOrigin`
   */
  buildFrustum(lens) {
    const params = this._params || {};
    const settings = this._settingsAt();
    const ratio = settings ? settings.value('zoom') : throwRange(params).min;
    const angles = throwAngles(ratio, params);
    const halfWidth = Math.tan((angles.horizontal / 2) * DEG2RAD) * FRUSTUM_LENGTH;
    const halfHeight = Math.tan((angles.vertical / 2) * DEG2RAD) * FRUSTUM_LENGTH;
    // Shift is a percentage of the picture, so it grows with the picture --
    // which is what makes it a property of the optics rather than of distance.
    // Negated, because this wireframe is built in the fixture's own frame while
    // shift is quoted from behind the machine -- and from there the viewer's
    // right is the fixture's -X. Without it the aid drew the picture on one
    // side and the light landed on the other, which is exactly how the
    // disagreement was spotted.
    const shiftX = settings ? -(settings.value('shiftH') / 100) * halfWidth * 2 : 0;
    const shiftZ = settings ? (settings.value('shiftV') / 100) * halfHeight * 2 : 0;
    // Forward is -Y, so the picture is further *down* the axis, not up it.
    const far = lens.y - FRUSTUM_LENGTH;
    const corners = [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ];

    const atX = lens.x + shiftX;
    const atZ = lens.z + shiftZ;

    const points = [];
    // Four rays from the glass to the corners of the picture...
    corners.forEach(([across, up]) => {
      points.push(lens.x, lens.y, lens.z, atX + across, far, atZ + up);
    });
    // ...and the picture's own outline, so the shape reads as a rectangle
    // rather than as four unrelated lines.
    for (let i = 0; i < corners.length; i += 1) {
      const from = corners[i];
      const to = corners[(i + 1) % corners.length];
      points.push(atX + from[0], far, atZ + from[1]);
      points.push(atX + to[0], far, atZ + to[1]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    if (this._frustum.geometry) this._frustum.geometry.dispose();
    this._frustum.geometry = geometry;
  }

  /**
   * Position of the body's centre, in metres.
   *
   * @type {Object}
   */
  set position(position) {
    this._position.set(position.x, position.y, position.z);
    this._dummy.position.copy(this._position);
    this._dummy.updateMatrixWorld();
  }

  get position() {
    return this._position;
  }

  /**
   * Orientation, as Euler radians matching the rest of the scene.
   *
   * @type {Object}
   */
  set rotation(rotation) {
    this._rotation.set(rotation.x, rotation.y, rotation.z);
    this._dummy.rotation.set(rotation.x, rotation.y, rotation.z);
    this._dummy.updateMatrixWorld();
  }

  get rotation() {
    return this._rotation;
  }

  /**
   * Nothing here depends on the address, so a repatch changes nothing.
   *
   * Present because `Fixture.notifyRepatched` calls it on any renderer that
   * offers it, and because a projector will have something to do here the day
   * Source Select reaches a video connector.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  repatch() {}

  /**
   * Grows a box to contain this projector's body.
   *
   * The barrel is left out on purpose: the selection box is a handle, and one
   * stretched forward by a long lens sits visibly off the machine it belongs
   * to. The body is what someone is pointing at.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  expandBounds(box) {
    const params = this._params || {};
    const width = Math.max(Number(params.width) || 0, 0.001);
    const height = Math.max(Number(params.height) || 0, 0.001);
    const depth = Math.max(Number(params.depth) || 0, 0.001);
    this._dummy.updateMatrixWorld();
    bodyBounds.min.set(-width / 2, -depth / 2, -height / 2);
    bodyBounds.max.set(width / 2, depth / 2, height / 2);
    bodyBounds.applyMatrix4(this._dummy.matrixWorld);
    box.union(bodyBounds);
  }

  /**
   * The same question for placement as for selection, as it is for a bar.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandGeometryBounds(box) {
    this.expandBounds(box);
  }

  /**
   * How far the body reaches below the fixture's origin.
   *
   * Half its height, and that is now a straight answer rather than a hedge:
   * local +Z is up, so an unrotated projector's height really is its vertical
   * extent. The bar says the same thing about its own thickness.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return (Number((this._params || {}).height) || 0) / 2;
  }

  /**
   * Shows or hides the outline and the throw together.
   *
   * The frustum is a selection aid rather than scenery: twelve projectors each
   * drawing an eight-metre teal cone would bury the rig they are aimed at.
   *
   * @public
   * @param {Boolean} state
   */
  showAids(state) {
    this._outline.visible = !!state;
    this._frustum.visible = !!state;
  }

  /**
   * Marks this projector as the single selected fixture.
   *
   * @public
   * @param {Boolean} state whether it is selected
   */
  setSinglyHighlighted(state) {
    this.showAids(state);
  }

  /**
   * Whether this projector is part of a multi-selection.
   *
   * A property rather than a method because that is how `Fixture.highlight()`
   * drives it.
   *
   * @type {Boolean}
   */
  set highlighted(state) {
    this._highlighted = !!state;
    this.showAids(this._highlighted);
  }

  get highlighted() {
    return this._highlighted;
  }

  /**
   * Drops a projector and everything it owns.
   *
   * The shared geometries and materials are left alone -- they belong to the
   * module, not to any one projector. The frustum is not shared and would leak.
   *
   * @static
   * @param {Projector} instance projector to remove
   */
  static deleteInstance(instance) {
    if (!instance) return;
    instances.delete(instance);
    if (instance._frustum && instance._frustum.geometry) instance._frustum.geometry.dispose();
    if (instance._outline && instance._outline.geometry) instance._outline.geometry.dispose();
    if (instance._dummy) SceneManager.remove(instance._dummy);
  }

  /**
   * Drops every projector's highlight.
   *
   * @static
   */
  static clearHighlighting() {
    instances.forEach((projector) => {
      projector._highlighted = false;
      projector.showAids(false);
    });
  }

  /**
   * What this machine is throwing, or null if it is throwing nothing.
   *
   * Rebuilt every frame rather than cached: zoom and shift are DMX-drivable, so
   * a console may be moving them, and the cost is four numbers and a matrix.
   *
   * @public
   * @returns {Object|null} `{ camera, lensMatrix, rect, lumensPerArea, gain }`
   */
  projection() {
    const connector = this._connectorAt();
    if (!connector) return null;

    const settings = this._settingsAt();
    // A closed shutter is a projector throwing nothing, not a black picture --
    // a black picture would still wash the wall.
    let gain = 1;
    if (settings) {
      gain = settings.value('shutter') ? (Number(settings.value('dimmer')) || 0) / 100 : 0;
    }
    if (gain <= 0) return null;

    const params = this._params || {};
    const ratio = settings ? Number(settings.value('zoom')) : 0;
    // Held as the percentage a spec sheet prints; the frustum wants a fraction.
    const shiftH = settings ? (Number(settings.value('shiftH')) || 0) / 100 : 0;
    const shiftV = settings ? (Number(settings.value('shiftV')) || 0) / 100 : 0;
    const frustum = throwFrustum(params, ratio, shiftH, shiftV);

    // Shared with the pass, which has to invert exactly this to read the atlas.
    const near = PROJECTOR_NEAR;
    const far = PROJECTOR_FAR;
    this._camera.projectionMatrix.makePerspective(
      frustum.left * near,
      frustum.right * near,
      frustum.top * near,
      frustum.bottom * near,
      near,
      far,
    );
    this._camera.projectionMatrixInverse.copy(this._camera.projectionMatrix).invert();

    const lens = lensOrigin(params);
    this._dummy.updateMatrixWorld();
    this._camera.matrixWorld
      .makeTranslation(lens.x, lens.y, lens.z)
      .multiply(this._basis)
      .premultiply(this._dummy.matrixWorld);
    this._camera.matrixWorldInverse.copy(this._camera.matrixWorld).invert();

    this._lensMatrix
      .copy(this._camera.projectionMatrix)
      .multiply(this._camera.matrixWorldInverse);

    // Percentages of the picture, as they are set; the pass wants fractions.
    const edge = (key) => (settings ? (Number(settings.value(key)) || 0) / 100 : 0);

    // Lumens spread over the picture this lens actually makes, which is what
    // turns a spec-sheet number into an illuminance the scene can be judged by.
    // The area at one metre falls straight out of the frustum, so a zoom or a
    // shift is accounted for without being asked about: narrow the lens and the
    // same lumens land on less wall and it gets brighter, exactly as it does.
    const imageWidth = frustum.right - frustum.left;
    const imageHeight = frustum.top - frustum.bottom;
    const areaAtOneMetre = Math.max(imageWidth * imageHeight, 1e-6);

    return {
      camera: this._camera,
      lensMatrix: this._lensMatrix,
      rect: connector.rect,
      // Lux times metres squared: divide by distance squared for lux.
      lumensPerArea: Math.max(Number(params.lumens) || 0, 0) / areaAtOneMetre,
      gain,
      blend: {
        left: edge('blendLeft'),
        right: edge('blendRight'),
        top: edge('blendTop'),
        bottom: edge('blendBottom'),
      },
    };
  }

  /**
   * Every projector currently throwing something.
   *
   * @static
   * @returns {Array}
   */
  static collect() {
    const out = [];
    instances.forEach((projector) => {
      const projection = projector.projection();
      if (projection) out.push(projection);
    });
    return out;
  }

  /**
   * Objects a raycast should test.
   *
   * @static
   * @returns {Array} the solid parts of every projector
   */
  static pickObjects() {
    const targets = [];
    instances.forEach((projector) => {
      targets.push(projector._body, projector._barrel, projector._ring);
    });
    return targets;
  }

  /**
   * Visits every projector with its world position, for rectangle selection.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, position)
   */
  static eachSelectable(visit) {
    instances.forEach((projector) => {
      if (projector.fixtureHandle) visit(projector.fixtureHandle, projector._position);
    });
  }
}

export default Projector;
