import * as THREE from 'three';
import SceneManager from './scene_manager';
import VideoRouter from './video_router';
import { pictureOf, pictureMapping } from '../../models/DMX/picture_controls';
import { createPanelMaterial } from './video_material';
import {
  DEFAULT_DISPLAY_PARAMS, pixelFill, displayCurve, stripShare,
} from '../../models/DMX/generic/display';
import BodyFinish from './body_finish';
import { castsContactShadow } from './contact_shadows';
import LightField, { SCENE_PER_NIT } from './light_field';
import Light from './light';
import DisplayLight from './display_light';
import { setOutlined } from './selection_outline';

/**
 * @file Renderer for a generic display: a bezelled box with a picture on it.
 *
 * The simplest consumer of the video path there is: the picture lands on the
 * display's own surface, so
 * nothing about projection, occlusion or depth is involved. If an image looks
 * wrong here the fault is in the connector or the feed.
 *
 * **Local axes follow the projector's**: +Z is up and the screen faces -Y,
 * which is the Front view -- so a display at zero rotation stands
 * upright facing the way an audience sits, rather than lying on its back.
 *
 * A display shows the whole of its input, turned and mirrored by its own
 * settings, as a real panel or LED processor does. The geometry UVs are
 * written from `orientedSample`, the one place that says what a rotation and a
 * mirror mean.
 */

/** Every display in the scene, so the statics can sweep them. */
const instances = new Set();

/**
 * The display's depth tile: a camera at the screen looking out along its
 * normal, wide enough for the light it throws at any useful angle. Points
 * past it are left unshadowed.
 */
const AREA_TILE_FOV = 150;

/** How far a display's light is followed, in metres. */
const AREA_RANGE = 60;

const screenNormal = new THREE.Vector3();
const screenCentre = new THREE.Vector3();
const lookTarget = new THREE.Vector3();

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
 * A plane floated a millimetre in front of a plain box is two parallel faces
 * covering the same pixels. Depth resolution falls off with the square of the
 * distance, so past about fifteen metres the two land in the same depth bucket
 * and the casing punches through the picture in hard bands. A bias would hide
 * that; an opening removes it, because there is no casing behind the picture.
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
 * @param {Object} curve
 * @param {Boolean} open a see-through panel's casing: the frame alone, with no
 *   back, so the room shows through the picture; nothing without a bezel
 * @returns {Object} THREE.BufferGeometry
 */
function buildCasing(width, height, depth, bezel, recess, curve, open = false) {
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

  if (open && !(bezel > 0)) return build.geometry();

  // Back, and the two ends. The ends are flat whatever the curve, because both
  // their edges sit at one arc position.
  if (!open) build.band(segments, along(-hx, hx, hz, depth), along(-hx, hx, -hz, depth));
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

  // An open frame has a back face as well, and its inner walls run the full
  // depth, since there is no box behind the picture for them to meet.
  if (open) {
    const back = (from, to, z0, z1, count) => {
      build.band(count, along(from, to, z1, depth), along(from, to, z0, depth));
    };
    back(-hx, hx, -hz, -h, segments);
    back(-hx, hx, h, hz, segments);
    back(-hx, -w, -h, h, 1);
    back(w, hx, -h, h, 1);
  }

  // The recess walls, facing inwards so they are seen from the front. With the
  // screen flush there is no recess and no walls -- see `recessFor`.
  const wall = open ? depth : recess;
  if (wall > 0) {
    build.quad(at(-w, -h, 0), at(-w, -h, wall), at(-w, h, wall), at(-w, h, 0));
    build.quad(at(w, -h, 0), at(w, h, 0), at(w, h, wall), at(w, -h, wall));
    build.band(segments, along(-w, w, -h, 0), along(-w, w, -h, wall));
    build.band(segments, along(-w, w, h, wall), along(-w, w, h, 0));
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
 * The casing: dark by default, because a screen's bezel is, and because
 * anything lighter competes with the picture it frames. A definition may pick
 * its own colour -- white monitors exist.
 */
const BODY = new BodyFinish({
  colour: DEFAULT_DISPLAY_PARAMS.bodyColor,
  roughness: 0.7,
  metalness: 0.15,
  lift: 0.25,
});

/**
 * What a screen showing nothing looks like.
 *
 * Not black: a black rectangle in a dark room is indistinguishable from a hole,
 * and someone who has just placed a display needs to see that it is there and
 * facing them. Unlit, so it reads whatever the scene lighting is doing.
 */
const BLANK_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x101418 });

/** Scratch box, reused while growing a selection box. */
const bodyBounds = new THREE.Box3();

class Display {
  /**
   * @param {Object} data
   * @param {Object} data.params display parameters, see the generic model
   * @param {Function} [data.settingsAt] () => the placement's DisplaySettings
   * @param {Function} [data.inputAt] () => the VideoInput it shows
   */
  constructor(data = {}) {
    this._params = data.params || {};
    this._settingsAt = data.settingsAt || (() => null);
    this._inputAt = data.inputAt || (() => null);
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
    this._body = new THREE.Mesh(new THREE.BufferGeometry(), BODY.material(this._params.bodyColor));
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);
    castsContactShadow(this._body);

    // Its own geometry, not the shared one: the UVs are per connector, so two
    // displays showing different slices cannot share a buffer.
    this._screen = new THREE.Mesh(new THREE.BufferGeometry(), BLANK_MATERIAL);
    this._screen.userData.pickOwner = this;
    this._dummy.add(this._screen);

    this.applyGeometry();
    this.refresh();
    instances.add(this);
    // The display lights the room with its picture's average, and casts
    // shadows from its own depth tile.
    if (this._level === undefined) this._level = 0;
    this._depthSlot = -1;
    this._depthRect = null;
    this._depthCam = new THREE.PerspectiveCamera(AREA_TILE_FOV, 1, 0.05, 100);
    LightField.register(this);
    Light.addAreaDepthSource(this);
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
    const open = !!params.seeThrough;
    this._body.geometry = buildCasing(width, height, depth, bezel, recess, curve, open);

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
    const input = this._inputAt();
    // Opens the input's feed if nothing else holds it; a no-op when unchanged.
    VideoRouter.use(this, input ? input.id : null);
    const feed = input ? VideoRouter.feedFor(input.id) : null;
    const settings = this._settingsAt();

    // Nothing selected, nothing bound, or nothing decoded yet. `displayTexture`
    // rather than `texture`: the raw one cannot be filtered, which is the whole
    // reason the decode pass exists.
    if (!feed || !feed.displayTexture) {
      const blank = this.blankMaterial();
      if (this._screen.material !== blank) this._screen.material = blank;
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
        stripShare: stripShare(this._params),
      });
      this._screen.material = this._material;
      this._feedGeneration = VideoRouter.generation();
    }

    this.writeScreenUvs(settings, feed);

    // Dimmer and blank fold into one number, because from the screen's point of
    // view they are the same thing: how much of the picture comes out.
    let level = 1;
    if (settings) {
      level = settings.value('shutter') ? (Number(settings.value('dimmer')) || 0) / 100 : 0;
    }
    this.setGain(level);
  }

  /**
   * What the screen shows with no picture: the shared blank, or for a
   * see-through panel its strips alone, so the room shows between them.
   *
   * @returns {THREE.Material}
   */
  blankMaterial() {
    const strips = stripShare(this._params);
    if (!(strips > 0)) return BLANK_MATERIAL;
    if (!this._blankStrips || this._blankStrips.opacity !== strips) {
      if (this._blankStrips) this._blankStrips.dispose();
      this._blankStrips = BLANK_MATERIAL.clone();
      this._blankStrips.transparent = true;
      this._blankStrips.opacity = strips;
      this._blankStrips.depthWrite = false;
    }
    return this._blankStrips;
  }

  /**
   * Scales the picture's brightness, whichever material is drawing it.
   *
   * Full white is the display's peak luminance, its nits, on the render
   * buffer's scale.
   *
   * @public
   * @param {Number} level 0..1, dimmer and shutter
   */
  setGain(level) {
    this._level = level;
    const material = this._material;
    if (!material) return;
    const stated = Number(this._params.nits);
    const nits = stated > 0 ? stated : DEFAULT_DISPLAY_PARAMS.nits;
    const gain = level * nits * SCENE_PER_NIT;
    if (material.uniforms && material.uniforms.gain) {
      material.uniforms.gain.value = gain;
    } else if (material.color) {
      // A plain map is multiplied by the material's colour, so a grey is a gain.
      material.color.setScalar(gain);
    }
  }

  /**
   * Points the screen at its input, turned and mirrored by the settings.
   *
   * A quarter turn and two mirrors are one reordering of the panel's
   * coordinates, through `orientedSample`. The inversions in `y` are the
   * texture's: the frame is uploaded with `flipY`, so v = 1 is the picture's
   * top row while the orientation counts downwards from the top-left.
   *
   * @public
   * @param {Object} settings the display's DisplaySettings, or null
   * @param {Object} [feed] the input's feed, for its size
   */
  writeScreenUvs(settings, feed = null) {
    const params = this._params || {};
    const mapping = pictureMapping(pictureOf(settings), {
      aspect: (Number(params.width) || 16) / (Number(params.height) || 9),
      pixelsWide: params.pixelsWide,
      pixelsHigh: params.pixelsHigh,
    }, feed ? { width: feed.width, height: feed.height } : {});
    const attribute = this._screen.geometry.attributes.uv;
    const panel = this._screen.geometry.attributes.panelUv;
    if (!attribute || !panel) return;
    // Driven by the panel coordinate rather than by a corner list, so a curved
    // screen -- which has as many vertices as it has facets -- maps the same way
    // a flat one does.
    const pick = (u, v) => {
      const at = mapping.map(u, 1 - v);
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
    const origin = pick(0, 0);
    const alongX = pick(1, 0);
    const alongY = pick(0, 1);
    // Where the input holds picture, in the texture's coordinates: outside it
    // is the black of a fitted picture's bars.
    const { bounds } = mapping;
    // The same frame for the light the display throws, which samples the
    // picture across the panel.
    this._pictureFrame = {
      origin: new THREE.Vector2(origin.x, origin.y),
      axisX: new THREE.Vector2(alongX.x - origin.x, alongX.y - origin.y),
      axisY: new THREE.Vector2(alongY.x - origin.x, alongY.y - origin.y),
      bounds: new THREE.Vector4(bounds.x0, 1 - bounds.y1, bounds.x1, 1 - bounds.y0),
    };
    const uniforms = this._material && this._material.uniforms;
    if (!uniforms || !uniforms.pictureAxisX) return;
    uniforms.pictureAxisX.value.copy(this._pictureFrame.axisX);
    uniforms.pictureAxisY.value.copy(this._pictureFrame.axisY);
    if (uniforms.pictureBounds) uniforms.pictureBounds.value.copy(this._pictureFrame.bounds);
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
   * What the selection outline is drawn round: its casing and its screen.
   *
   * @public
   * @returns {Array<THREE.Mesh>}
   */
  outlineMeshes() {
    return [this._body, this._screen];
  }

  /**
   * @public
   * @param {Boolean} state
   */
  setSinglyHighlighted(state) {
    setOutlined(this, !!state, this.outlineMeshes());
  }

  /**
   * @type {Boolean}
   */
  set highlighted(state) {
    this._highlighted = !!state;
    setOutlined(this, this._highlighted, this.outlineMeshes());
  }

  get highlighted() {
    return this._highlighted;
  }

  /**
   * Whether the fixture is hidden from the scene: not drawn, and its screen with
   * it. A display puts no light anywhere else.
   * Picking skips it by asking the fixture, not this.
   *
   * @type {Boolean}
   */
  set hidden(state) {
    this._hidden = !!state;
    this._dummy.visible = !this._hidden;
  }

  get hidden() {
    return !!this._hidden;
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
   * nothing to draw yet, and without this a display stays black until some
   * unrelated edit happens to call `refresh` again.
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
   * Averages every lit display's picture, for the light it throws.
   *
   * @static
   * @param {THREE.WebGLRenderer} renderer
   */
  static updateLight(renderer) {
    const entries = [];
    instances.forEach((display) => {
      if (!display.lights()) return;
      const input = display._inputAt();
      const feed = input ? VideoRouter.feedFor(input.id) : null;
      if (!feed || !feed.displayTexture) return;
      entries.push({
        owner: display, texture: feed.displayTexture, frame: display._pictureFrame || null,
      });
    });
    DisplayLight.update(renderer, entries);
  }

  /** Whether the display is showing anything, and so lighting the room. */
  lights() {
    return !this._hidden && this._level > 0 && this._material !== null;
  }

  /** The screen's centre and outward normal, world. */
  screenFrame() {
    this._dummy.updateMatrixWorld();
    // The screen faces -Y in the display's own frame.
    screenNormal.set(0, -1, 0).transformDirection(this._dummy.matrixWorld);
    this._dummy.getWorldPosition(screenCentre);
  }

  /**
   * The display as an area light, for `LightField`: a matte emitter at its
   * nits, coloured by its picture's average, with a disc of its own area as
   * the radius that softens its light and its shadows.
   *
   * @public
   * @param {Object} record
   * @returns {Boolean} whether it is lighting anything
   */
  readLight(record) {
    if (!this.lights()) return false;
    const average = DisplayLight.averageOf(this);
    if (!average) return false;
    const params = this._params || {};
    const width = Math.max(Number(params.width) || 0, 0.001);
    const height = Math.max(Number(params.height) || 0, 0.001);
    const area = width * height;
    const stated = Number(params.nits);
    const nits = stated > 0 ? stated : DEFAULT_DISPLAY_PARAMS.nits;

    this.screenFrame();
    record.position.copy(screenCentre).addScaledVector(screenNormal, 0.01);
    record.direction.copy(screenNormal).negate();
    record.color.copy(average);
    // Luminance times area is the candela straight out; on the field's scale.
    record.intensity = nits * this._level * area * SCENE_PER_NIT;
    record.range = AREA_RANGE;
    record.cosOuter = 0;
    record.cosInner = 0;
    record.iris = -1;
    record.lensRadius = Math.sqrt(area / Math.PI);
    // Width along the display's x, height along its z, wound for the field:
    // half-width cross half-height points away from the lit side.
    record.rectX.set(width / 2, 0, 0).transformDirection(this._dummy.matrixWorld).multiplyScalar(width / 2);
    record.rectY.set(0, 0, 1).transformDirection(this._dummy.matrixWorld).multiplyScalar(height / 2);
    const mirrored = lookTarget.crossVectors(record.rectX, record.rectY).dot(screenNormal) > 0;
    if (mirrored) record.rectX.negate();
    // The picture's tile in the display atlas, 1-based, negative when the
    // rectangle's x runs against the panel's.
    const slot = DisplayLight.slotOf(this);
    record.pictureSlot = slot < 0 ? 0 : (slot + 1) * (mirrored ? -1 : 1);
    if (this._depthSlot >= 0 && this._depthRect) {
      const cam = this._depthCam;
      record.hasTile = true;
      record.tile.copy(this._depthRect);
      record.tileOrigin.copy(cam.position);
      // The field reads the tile with x mirrored, as the movers' cameras are.
      record.axisX.set(-1, 0, 0).applyQuaternion(cam.quaternion);
      record.axisY.set(0, 1, 0).applyQuaternion(cam.quaternion);
      record.tanHalf = Math.tan(THREE.MathUtils.degToRad(AREA_TILE_FOV / 2));
    }
    return true;
  }

  /**
   * The depth tile this display wants this frame, for `Light.renderDepth`.
   *
   * @public
   * @param {Number} near the atlas's near plane
   * @param {Number} far the atlas's far plane
   * @returns {Object|null} `{ camera, priority }`
   */
  depthRequest(near, far) {
    if (!this.lights()) return null;
    const cam = this._depthCam;
    if (cam.near !== near || cam.far !== far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    this.screenFrame();
    cam.position.copy(screenCentre).addScaledVector(screenNormal, 0.02);
    cam.up.set(0, 0, 1).transformDirection(this._dummy.matrixWorld);
    cam.lookAt(lookTarget.copy(cam.position).add(screenNormal));
    cam.updateMatrixWorld();
    return { camera: cam, priority: this._level };
  }

  /**
   * @public
   * @param {Number} slot the atlas slot, -1 none
   * @param {THREE.Vector4|null} rect the tile in the atlas, uv
   */
  setDepthSlot(slot, rect) {
    this._depthSlot = slot;
    this._depthRect = rect;
  }

  /**
   * @public
   */
  sync() {
    const input = this._inputAt();
    const feed = input ? VideoRouter.feedFor(input.id) : null;
    const ready = !!(feed && feed.displayTexture);
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
    LightField.unregister(instance);
    Light.removeAreaDepthSource(instance);
    DisplayLight.forget(instance);
    VideoRouter.drop(instance);
    if (instance._material) instance._material.dispose();
    if (instance._body) instance._body.geometry.dispose();
    if (instance._screen) instance._screen.geometry.dispose();
    setOutlined(instance, false);
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
