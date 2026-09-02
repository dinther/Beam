import * as THREE from 'three';
import SceneManager from './scene_manager';
import VideoRouter from './video_router';
import { createPanelMaterial } from './video_material';
import { pixelFill, displayCurve } from '../../models/DMX/generic/display';

/**
 * @file Renderer for a generic display: a bezelled box with a picture on it.
 *
 * The simplest consumer of the video path there is, and deliberately built
 * before the projector's: the picture lands on the display's own surface, so
 * nothing about projection, occlusion or depth is involved. If an image looks
 * wrong here the fault is in the connector or the feed.
 *
 * **Local axes follow the projector's**: +Z is up and the screen faces -Y,
 * which the view cube calls Front -- so a display at zero rotation stands
 * upright facing the way an audience sits, rather than lying on its back.
 *
 * The crop is done exactly the way the slicing editor does it: four geometry
 * UVs written from `VideoConnector.sampleAt`. That method is the one place that
 * says what a rotation and a flip mean, and this is its second caller -- the
 * whole reason it was put on the model rather than in the editor.
 */

/** Every display in the scene, so the statics can sweep them. */
const instances = new Set();

/**
 * Unit box, scaled per display for the selection outline only. The casing
 * itself is built per instance by `buildCasing`, because a frame cannot be
 * scaled out of a cube without stretching its border.
 */
const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/**
 * A point on the display's surface, in the fixture's own space.
 *
 * Everything the casing and the screen are made of is expressed through this,
 * so a curve is described once and every face follows it.
 *
 * `sx` is measured **along** the surface, not across the room: bending a panel
 * moves its edges closer together without making it a smaller display, which is
 * how a real one behaves -- the pixels do not go anywhere.
 *
 * @param {Number} sx arc position from the centre, metres
 * @param {Number} sz height from the centre, metres
 * @param {Number} offset metres behind the front face
 * @param {Object} curve `{ radius, sign }` from the model, radius 0 for flat
 * @param {Number} hy half the casing depth
 * @returns {Array} `[x, y, z]`
 */
function surfacePoint(sx, sz, offset, curve, hy) {
  if (!curve.radius) return [sx, -hy + offset, sz];
  // The centre of curvature sits behind the screen for a convex panel and in
  // front of it for a concave one, which is the whole of the difference: one
  // sign, carried through the radius and the sweep together.
  const { radius, sign } = curve;
  const angle = sx / radius;
  const r = radius - sign * offset;
  const centre = -hy + sign * radius;
  return [r * Math.sin(angle), centre - sign * r * Math.cos(angle), sz];
}

/**
 * How many facets to bend a surface into.
 *
 * One per three degrees or so, which is under a pixel of chord error on any
 * panel small enough to look at. Flat panels get a single quad, so a straight
 * display costs exactly what it did before curves existed.
 *
 * @param {Object} curve
 * @returns {Number}
 */
function curveSegments(curve) {
  if (!curve.radius) return 1;
  return Math.min(Math.max(Math.ceil(curve.angle / (Math.PI / 60)), 2), 128);
}

/**
 * Collects quads into position/normal/index arrays.
 *
 * Normals come out of the cross product rather than being asserted, which is
 * what makes a curved face safe to build: the same call that places a flat
 * strip places a bent one.
 *
 * @returns {Object}
 */
function meshBuilder() {
  const position = [];
  const normal = [];
  const index = [];
  const quad = (a, b, c, d) => {
    const base = position.length / 3;
    const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
    const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    [a, b, c, d].forEach((corner) => {
      position.push(corner[0], corner[1], corner[2]);
      normal.push(nx, ny, nz);
    });
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // Two edges swept together. `first` and `second` each give a point for a
  // position along the sweep; which is which decides the facing.
  const band = (segments, first, second) => {
    for (let i = 0; i < segments; i += 1) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      quad(first(t0), first(t1), second(t1), second(t0));
    }
  };
  const geometry = () => {
    const built = new THREE.BufferGeometry();
    built.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    built.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    built.setIndex(index);
    return built;
  };
  return { quad, band, geometry };
}

/**
 * The screen itself: the surface the picture is drawn on.
 *
 * Carries the panel's own 0-1 coordinate as `panelUv`, which is what the pixel
 * grid is drawn on and what the connector's slice is sampled through. The `uv`
 * attribute starts as a copy and is rewritten per connector.
 *
 * @param {Number} width picture width
 * @param {Number} height picture height
 * @param {Number} offset how far back from the casing's front face
 * @param {Object} curve
 * @param {Number} hy half the casing depth
 * @returns {Object} THREE.BufferGeometry
 */
function buildScreen(width, height, offset, curve, hy) {
  const segments = curveSegments(curve);
  const w = width / 2;
  const h = height / 2;
  const build = meshBuilder();
  const at = (sz) => (t) => surfacePoint(-w + t * width, sz, offset, curve, hy);
  build.band(segments, at(-h), at(h));
  const geometry = build.geometry();

  // One per vertex, in the order the quads were pushed: four corners each,
  // lower edge first, matching `band`.
  const panel = [];
  for (let i = 0; i < segments; i += 1) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    panel.push(t0, 0, t1, 0, t1, 1, t0, 1);
  }
  geometry.setAttribute('panelUv', new THREE.Float32BufferAttribute(panel, 2));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from(panel), 2));
  return geometry;
}

/**
 * The casing: a box whose front is a frame with a hole in it.
 *
 * The screen used to be a plane floated a millimetre in front of a plain box,
 * which is two parallel faces covering the same pixels. Depth resolution falls
 * off with the square of the distance, so past about fifteen metres the two
 * landed in the same depth bucket and the casing punched through the picture in
 * hard bands. A bias would hide that; an opening removes it, because there is
 * no longer any casing behind the picture to come through it.
 *
 * So the front is built as four strips around a hole the size of the picture,
 * and the screen sits at the bottom of a shallow recess, joined to the rim by
 * four inner walls. Nothing overlaps anything, which is also how a real display
 * is put together.
 *
 * Built per instance rather than scaled from a shared unit box: a bezel is a
 * fixed width all the way round, and non-uniform scaling would stretch it with
 * the picture.
 *
 * @param {Number} width picture width, metres
 * @param {Number} height picture height
 * @param {Number} depth casing depth
 * @param {Number} bezel border width around the picture
 * @param {Number} recess how far the screen sits back from the front face
 * @returns {Object} THREE.BufferGeometry
 */
function buildCasing(width, height, depth, bezel, recess, curve) {
  const outer = width + bezel * 2;
  const hx = outer / 2;
  const hz = height / 2 + bezel;
  const hy = depth / 2;
  const w = width / 2;
  const h = height / 2;
  const segments = curveSegments(curve);
  const build = meshBuilder();
  const at = (sx, sz, offset) => surfacePoint(sx, sz, offset, curve, hy);

  // An edge swept along the surface: fixed height and depth, running from one
  // arc position to another.
  const along = (from, to, sz, offset) => (t) => at(from + (to - from) * t, sz, offset);

  // Back, and the two ends. The ends are flat whatever the curve, because both
  // their edges sit at one arc position.
  build.band(segments, along(-hx, hx, hz, depth), along(-hx, hx, -hz, depth));
  build.quad(at(hx, -hz, 0), at(hx, -hz, depth), at(hx, hz, depth), at(hx, hz, 0));
  build.quad(at(-hx, -hz, 0), at(-hx, hz, 0), at(-hx, hz, depth), at(-hx, -hz, depth));

  // Top and bottom, swept along the curve.
  build.band(segments, along(-hx, hx, hz, 0), along(-hx, hx, hz, depth));
  build.band(segments, along(-hx, hx, -hz, depth), along(-hx, hx, -hz, 0));

  // The front, as four strips around the opening. With no bezel these come out
  // zero-area and the front is simply open, which is correct.
  // Skipped outright when there is no border, rather than emitted with no
  // area: a zero-size quad has no normal to compute and nothing to draw.
  if (bezel > 0) {
    const frame = (from, to, z0, z1, count) => {
      build.band(count, along(from, to, z0, 0), along(from, to, z1, 0));
    };
    frame(-hx, hx, -hz, -h, segments);
    frame(-hx, hx, h, hz, segments);
    frame(-hx, -w, -h, h, 1);
    frame(w, hx, -h, h, 1);
  }

  // The recess walls, facing inwards so they are seen from the front. With the
  // screen flush there is no recess and no walls -- see `recessFor`.
  if (recess > 0) {
    build.quad(at(-w, -h, 0), at(-w, -h, recess), at(-w, h, recess), at(-w, h, 0));
    build.quad(at(w, -h, 0), at(w, h, 0), at(w, h, recess), at(w, -h, recess));
    build.band(segments, along(-w, w, -h, 0), along(-w, w, -h, recess));
    build.band(segments, along(-w, w, h, recess), along(-w, w, h, 0));
  }

  return build.geometry();
}

/**
 * How far the picture sits back from the front of the casing.
 *
 * Half the bezel reads like a real display without making a deep box of it,
 * capped at 15 mm because no panel is set deeper than that and a wide bezel
 * would otherwise give it a lit inner wall thick enough to read as a box.
 *
 * **No bezel means no recess.** It is tempting to keep a millimetre or two so
 * the picture sits inside the casing, but with no border there is no front face
 * to sit inside: the recess walls would land exactly on the outer sides,
 * back to back with them, which is the same pair of coincident surfaces this
 * geometry exists to avoid. Culling hides it and depth precision would not.
 * Flush is also what a bezel-less display is.
 *
 * @param {Number} bezel
 * @param {Number} depth
 * @returns {Number} metres
 */
function recessFor(bezel, depth) {
  return Math.min(bezel * 0.5, depth * 0.4, 0.015);
}

/**
 * The casing: dark, because a screen's bezel is, and because anything lighter
 * competes with the picture it frames.
 */
const BODY_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x35383c,
  emissive: 0x0d0e0f,
  roughness: 0.7,
  metalness: 0.15,
});

/**
 * What a screen showing nothing looks like.
 *
 * Not black: a black rectangle in a dark room is indistinguishable from a hole,
 * and someone who has just placed a display needs to see that it is there and
 * facing them. Unlit, so it reads whatever the scene lighting is doing.
 */
const BLANK_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x101418 });

/** Outline shown while a display is selected. Matches the bar's and the projector's. */
const HIGHLIGHT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1ca6bd });

/** Scratch box, reused while growing a selection box. */
const bodyBounds = new THREE.Box3();

class Display {
  /**
   * @param {Object} data
   * @param {Object} data.params display parameters, see the generic model
   * @param {Function} [data.settingsAt] () => the placement's DisplaySettings
   * @param {Function} [data.connectorAt] () => the VideoConnector it shows
   */
  constructor(data = {}) {
    this._params = data.params || {};
    this._settingsAt = data.settingsAt || (() => null);
    this._connectorAt = data.connectorAt || (() => null);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this.unsupported = false;
    this.fixtureHandle = null;
    this._highlighted = false;
    this._feedGeneration = -1;
    this._material = null;
    // What `sync` last saw, so a per-frame check costs two comparisons.
    this._ready = false;
    this._syncGeneration = -1;

    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    // Filled in by `applyGeometry`, which is the only thing that shapes it.
    this._body = new THREE.Mesh(new THREE.BufferGeometry(), BODY_MATERIAL);
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);

    // Its own geometry, not the shared one: the UVs are per connector, so two
    // displays showing different slices cannot share a buffer.
    this._screen = new THREE.Mesh(new THREE.BufferGeometry(), BLANK_MATERIAL);
    this._screen.userData.pickOwner = this;
    this._dummy.add(this._screen);

    this._outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(BOX_GEOMETRY),
      HIGHLIGHT_MATERIAL,
    );
    this._outline.visible = false;
    this._dummy.add(this._outline);

    this.applyGeometry();
    this.refresh();
    instances.add(this);
  }

  /**
   * Sizes the casing and the screen from the profile's numbers.
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
    const bezel = Math.max(Number(params.bezel) || 0, 0);

    // The casing is the picture plus its border, all the way round. The curve
    // is taken on the *outer* width, since that is the arc being bent.
    const recess = recessFor(bezel, depth);
    const curve = displayCurve(params, width + bezel * 2);
    this._body.geometry.dispose();
    this._body.geometry = buildCasing(width, height, depth, bezel, recess, curve);
    this._outline.scale.set(width + bezel * 2, depth, height + bezel * 2);

    // On the floor of the recess, filling the opening exactly and bent on the
    // same curve. The walls meet it at right angles, so there is no pair of
    // faces anywhere that could fight. Built in real metres, so it neither
    // scales nor moves: both are in the geometry.
    this._screen.geometry.dispose();
    this._screen.geometry = buildScreen(width, height, recess, curve, depth / 2);
    this._screen.scale.set(1, 1, 1);
    this._screen.position.set(0, 0, 0);
  }

  /**
   * Re-reads the feed and the connector, and rebuilds what the screen shows.
   *
   * Called when the source changes, when the connector's rectangle is edited,
   * and when a channel writes -- for a display those are the same event seen
   * from three sides.
   *
   * @public
   */
  refresh() {
    const feed = VideoRouter.feed();
    const connector = this._connectorAt();
    const settings = this._settingsAt();

    // Nothing selected, nothing bound, or nothing decoded yet. `displayTexture`
    // rather than `texture`: the raw one cannot be filtered, which is the whole
    // reason the decode pass exists.
    if (!feed || !feed.displayTexture || !connector) {
      if (this._screen.material !== BLANK_MATERIAL) this._screen.material = BLANK_MATERIAL;
      this._material = null;
      this._feedGeneration = -1;
      return;
    }

    // The material belongs to the feed's texture and its packing, and to this
    // panel's own pixel grid, so it is rebuilt when the source changes and not
    // before -- the shader picks its unpacking from the feed's format.
    if (this._material === null || this._feedGeneration !== VideoRouter.generation()) {
      if (this._material) this._material.dispose();
      const fill = pixelFill(this._params);
      this._material = createPanelMaterial(feed.displayTexture, {
        pixelsWide: this._params.pixelsWide,
        pixelsHigh: this._params.pixelsHigh,
        fillX: fill.x,
        fillY: fill.y,
      });
      this._screen.material = this._material;
      this._feedGeneration = VideoRouter.generation();
    }

    this.writeScreenUvs(connector);

    // Dimmer and blank fold into one number, because from the screen's point of
    // view they are the same thing: how much of the picture comes out.
    let level = 1;
    if (settings) {
      level = settings.value('shutter') ? (Number(settings.value('dimmer')) || 0) / 100 : 0;
    }
    this.setGain(level);
  }

  /**
   * Scales the picture's brightness, whichever material is drawing it.
   *
   * @public
   * @param {Number} gain 0..1
   */
  setGain(gain) {
    const material = this._material;
    if (!material) return;
    if (material.uniforms && material.uniforms.gain) {
      material.uniforms.gain.value = gain;
    } else if (material.color) {
      // A plain map is multiplied by the material's colour, so a grey is a gain.
      material.color.setScalar(gain);
    }
  }

  /**
   * Points the screen's corners at the region the connector describes.
   *
   * The same four-corner permutation the slicing editor uses, through the same
   * `sampleAt` -- a crop, a quarter turn and two mirrors are one reordering of
   * four pairs. The inversions in `y` are the texture's, not the connector's:
   * the frame is uploaded with `flipY`, so v = 1 is the picture's top row while
   * every coordinate on a connector counts downwards from the top-left.
   *
   * @public
   * @param {Object} connector a VideoConnector
   */
  writeScreenUvs(connector) {
    const attribute = this._screen.geometry.attributes.uv;
    const panel = this._screen.geometry.attributes.panelUv;
    if (!attribute || !panel) return;
    // Driven by the panel coordinate rather than by a corner list, so a curved
    // screen -- which has as many vertices as it has facets -- maps the same way
    // a flat one does.
    const pick = (u, v) => {
      const at = connector.sampleAt(u, 1 - v);
      return { x: at.x, y: 1 - at.y };
    };
    for (let i = 0; i < attribute.count; i += 1) {
      const at = pick(panel.getX(i), panel.getY(i));
      attribute.setXY(i, at.x, at.y);
    }
    attribute.needsUpdate = true;

    // How far the picture moves for one unit of panel coordinate. The shader
    // needs it to carry a cell centre found on the panel back into the picture,
    // and taking it from the mapping itself means a rotated or mirrored slice
    // is already accounted for.
    const uniforms = this._material && this._material.uniforms;
    if (!uniforms || !uniforms.pictureAxisX) return;
    const origin = pick(0, 0);
    const alongX = pick(1, 0);
    const alongY = pick(0, 1);
    uniforms.pictureAxisX.value.set(alongX.x - origin.x, alongX.y - origin.y);
    uniforms.pictureAxisY.value.set(alongY.x - origin.x, alongY.y - origin.y);
  }

  /**
   * Position of the casing's centre, in metres.
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

  // eslint-disable-next-line class-methods-use-this
  repatch() {}

  /**
   * Grows a box to contain this display's casing.
   *
   * @public
   * @param {Object} box THREE.Box3 to expand, in world space
   */
  expandBounds(box) {
    const params = this._params || {};
    const bezel = Math.max(Number(params.bezel) || 0, 0);
    const width = Math.max(Number(params.width) || 0, 0.001) + bezel * 2;
    const height = Math.max(Number(params.height) || 0, 0.001) + bezel * 2;
    const depth = Math.max(Number(params.depth) || 0, 0.001);
    // A curve pushes the surface out of the box the numbers describe: a convex
    // panel's edges fall away behind it, a concave one's reach in front. The
    // arc also draws the ends inwards, but the box is kept wide -- a selection
    // box that is a little generous is harmless, one that clips is not.
    const curve = displayCurve(this._params || {}, width);
    const sag = curve.radius ? curve.radius * (1 - Math.cos(curve.angle / 2)) : 0;
    this._dummy.updateMatrixWorld();
    bodyBounds.min.set(-width / 2, -depth / 2 - (curve.sign < 0 ? sag : 0), -height / 2);
    bodyBounds.max.set(width / 2, depth / 2 + (curve.sign > 0 ? sag : 0), height / 2);
    bodyBounds.applyMatrix4(this._dummy.matrixWorld);
    box.union(bodyBounds);
  }

  /**
   * @public
   * @param {Object} box THREE.Box3 to expand
   */
  expandGeometryBounds(box) {
    this.expandBounds(box);
  }

  /**
   * How far the casing reaches below the fixture's origin.
   *
   * Half its height, straightforwardly: local +Z is up, so an unrotated
   * display's height really is its vertical extent.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    const params = this._params || {};
    const bezel = Math.max(Number(params.bezel) || 0, 0);
    return ((Number(params.height) || 0) + bezel * 2) / 2;
  }

  /**
   * @public
   * @param {Boolean} state
   */
  setSinglyHighlighted(state) {
    this._outline.visible = !!state;
  }

  /**
   * @type {Boolean}
   */
  set highlighted(state) {
    this._highlighted = !!state;
    this._outline.visible = this._highlighted;
  }

  get highlighted() {
    return this._highlighted;
  }

  /**
   * Rebuilds every display, for when the source or a connector changes.
   *
   * @static
   */
  static refreshAll() {
    instances.forEach((display) => display.refresh());
  }

  /**
   * Notices when a screen becomes able to show something, or stops being able.
   *
   * Called every drawn frame, and it has to be, because **a feed has no texture
   * until its first frame lands** -- which is always after the source was
   * chosen. Selecting a source announces immediately, at which point there is
   * nothing to draw yet, and without this a display stayed black until some
   * unrelated edit happened to call `refresh` again. That is precisely how it
   * behaved: picking a connector did nothing, and toggling any other control
   * made the picture appear.
   *
   * Two comparisons per display per frame. `refresh` itself is not called
   * blindly because it rewrites the screen's UVs, which is real work for an
   * answer that almost never changes.
   *
   * @static
   */
  static syncAll() {
    instances.forEach((display) => display.sync());
  }

  /**
   * @public
   */
  sync() {
    const feed = VideoRouter.feed();
    const ready = !!(feed && feed.displayTexture && this._connectorAt());
    const generation = VideoRouter.generation();
    if (ready === this._ready && generation === this._syncGeneration) return;
    this._ready = ready;
    this._syncGeneration = generation;
    this.refresh();
  }

  /**
   * Drops a display and everything it owns.
   *
   * @static
   * @param {Display} instance
   */
  static deleteInstance(instance) {
    if (!instance) return;
    instances.delete(instance);
    if (instance._material) instance._material.dispose();
    if (instance._body) instance._body.geometry.dispose();
    if (instance._screen) instance._screen.geometry.dispose();
    if (instance._outline) instance._outline.geometry.dispose();
    if (instance._dummy) SceneManager.remove(instance._dummy);
  }

  /**
   * @static
   */
  static clearHighlighting() {
    instances.forEach((display) => {
      display._highlighted = false;
      display.setSinglyHighlighted(false);
    });
  }

  /**
   * @static
   * @returns {Array} the pickable parts of every display
   */
  static pickObjects() {
    const targets = [];
    instances.forEach((display) => targets.push(display._body, display._screen));
    return targets;
  }

  /**
   * @static
   * @param {Function} visit called with (fixtureHandle, position)
   */
  static eachSelectable(visit) {
    instances.forEach((display) => {
      if (display.fixtureHandle) visit(display.fixtureHandle, display._position);
    });
  }
}

// Every display follows the one source the scene is showing.
VideoRouter.listen(() => Display.refreshAll());

export default Display;
