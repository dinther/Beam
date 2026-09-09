/* eslint-disable no-bitwise */
// A streamed point's x/y is a signed 16-bit galvo value carried as its bit
// pattern; sign-extending it is the subject matter, not an accident.
import * as THREE from 'three';
import SceneManager from './scene_manager';
import SceneEnv from './scene_env';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import { DepthAtlas } from './projector_depth';
import { flattenPaths } from './laser_dwell';
import FIGURE_ATLAS, { LaserFigure, setLineWidth, lineWidth } from './laser_figure';
import LaserStream, { POINT_STRIDE } from '../laser_stream';
import { apertureOrigin, scanHalfAngles } from '../../models/DMX/generic/laser';

/**
 * The lasers' own depth atlas, so a beam can stop at the first surface each ray
 * meets. Separate instance from the projectors' -- same engine, its own tiles
 * and texture unit, no coupling between the two passes. Smaller tiles than a
 * projector's (the occlusion grain, not the figure) and a shorter range, since
 * a laser lights a room rather than a distant facade. 4x4 = sixteen lasers.
 */
const LASER_DEPTH = new DepthAtlas({
  columns: 4, rows: 4, tile: 512, near: 0.5, far: 120, linear: true,
});

/**
 * Debug-panel knobs, applied to every laser's material each frame.
 *
 * The numbers are where Paul settled them against the church with MadMapper
 * running, rather than round values chosen up front -- a laser that looks right
 * out of the box beats one that needs six sliders moved before it does.
 */
let scatterGainValue = 0.55;
let hazeBaseValue = 0.4;

/** How hard the figure is painted onto geometry, over the pass's own gain. */
let surfaceGainValue = 4.0;

/**
 * How much dimmer a beam gets as it turns away from the viewer, 0 to 1.
 *
 * One number rather than the three the maths wants. Haze scatters light
 * overwhelmingly forwards, so a beam coming at you is far brighter than the
 * same beam crossing your view, with a weaker lobe straight back the way it
 * came. Those shapes are fixed at values that match real haze; this says how
 * much of the difference to show. 0 is a beam that looks the same from every
 * angle; 1 lets a side-on beam fall to a small fraction of a head-on one.
 *
 * A beam aimed at the eye is the reference and never brightens, whatever this
 * is set to -- so turning it up costs no exposure.
 */
let scatterAmountValue = 0.69;

/** Scratch, reused each frame so `renderDepth` allocates nothing. */
const scratchResolution = new THREE.Vector2();

/** Local space to the aperture camera's clip space, for placing the figure. */
const scratchClip = new THREE.Matrix4();

/**
 * Whether beams are truncated at the first surface via the aperture depth pass.
 *
 * Two things had to be right before this could be turned on. The scene's
 * background was being clear-blitted into every atlas tile by `WebGLBackground`
 * on each `renderer.render`, so empty sky unpacked to a surface about 22 m out
 * and beams were cut against open air; and the floor packed as noise, because
 * `MeshDepthMaterial` derives depth from an interpolated varying and a ground
 * plane is two triangles running from behind the camera to far in front, which
 * makes that varying meaningless. Both are fixed in `projector_depth.js` -- the
 * background stands down for the pass, and the atlas packs linear view distance
 * taken from `gl_FragCoord.z`, which the rasteriser computes after clipping.
 */
const OCCLUSION_ENABLED = true;

/**
 * @file Renderer for a generic RGB show laser: a box with an aperture.
 *
 * The body only. A laser's interesting part is the figure it draws in the air
 * and on surfaces from its DAC point stream; that is a later step. This is the
 * chassis, so the fixture is visible, selectable and placeable in the meantime
 * -- built the same way as the projector's, and for the same reasons: a cube
 * and a small aperture disc, driven from the profile's own numbers, not
 * instanced (a rig has a handful of lasers, not two hundred movers).
 *
 * **Local axes match the projector's: +Z is up and the beam leaves along -Y.**
 * So a laser at zero rotation stands on its feet and fires at the scene's
 * Front rather than the ceiling. See `projector.js` for the full argument;
 * this fixture follows the same convention so the two read alike in a rig.
 */

/** Every laser in the scene, so the statics can sweep them. */
const instances = new Set();

/** As many named IDN services as there are tiles for lasers. */
const MAX_SERVICES = 16;

/** The service list last sent, so an unchanged patch is not republished. */
let lastInputs = '';

/** Unit body, scaled per laser. */
const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/** The aperture disc. A circle faces +Z, and the beam leaves along -Y. */
const APERTURE_GEOMETRY = new THREE.CircleGeometry(0.5, 20);
APERTURE_GEOMETRY.rotateX(Math.PI / 2);

/**
 * A dark chassis -- lasers are near-black boxes -- lifted just off true black
 * so it reads in an unlit room.
 *
 * The projector taught this: a lit material in a dark scene reflects nothing
 * and a near-black body has no silhouette against the near-black ground. A
 * laser should still look black, so it sits much darker than the projector's
 * light-grey install chassis, but the small emissive floor keeps its faces
 * from collapsing into the background. The aperture carries most of the read.
 */
const BODY_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x303336,
  emissive: 0x1c1f22,
  roughness: 0.5,
  metalness: 0.3,
});

/**
 * The aperture, unlit teal on purpose.
 *
 * `MeshBasicMaterial` ignores scene lighting, so the one part that says which
 * way a laser points is legible in a black room with nothing switched on --
 * the same trick, and the same accent, as the projector's glass and the create
 * dialog's lens.
 */
const APERTURE_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x1ca6bd });

/** Outline shown while a laser is selected. Matches the projector's. */
const HIGHLIGHT_MATERIAL = new THREE.LineBasicMaterial({ color: 0x1ca6bd });

/** The aim line, drawn only while selected. */
const AIM_MATERIAL = new THREE.LineBasicMaterial({
  color: 0x1ca6bd,
  transparent: true,
  opacity: 0.5,
});

/**
 * How far the aim line is drawn, in metres.
 *
 * An aid, not a measurement: a real beam runs until it hits something, and the
 * figure it draws is the point stream's, not a fixed cone. Long enough to show
 * which way the machine is aimed, short enough not to fill the scene.
 */
const AIM_LENGTH = 6;

/** Scratch box, reused while growing a selection box. */
const bodyBounds = new THREE.Box3();

/**
 * How long a beam is drawn, in metres, before anything stops it.
 *
 * A real beam runs until it hits something; this is a first pass with no
 * per-fixture occlusion, so beams run to a fixed length and scatter in haze
 * along the way. Where a beam ends on geometry is a later step -- the same
 * depth-atlas question the projector and the mover beam-stop both have.
 */
let beamLengthValue = 120;

/** How much of the shaft's end is given over to fading out. */
let beamTailValue = 0.7;

/**
 * Most points a beam holds at once, matching the stream's ring.
 *
 * One triangle spans each consecutive pair, so the geometry is sized for one
 * fewer triangle than this and updated in place every frame rather than
 * reallocated.
 */
// Raised from 4096 for Ponk, where one circle arrives as 8,146 points. This is
// the frame's whole budget now, not a cut: `flattenPaths` spreads it over the
// frame's total length, so a dense frame comes back a little coarser
// everywhere rather than missing the shapes that did not fit.
const MAX_POINTS = 8192;

/**
 * A stored Ponk source, decoded.
 *
 * `ponk:<sender id>` -- the 32-bit identifier MadMapper keeps across project
 * reloads, which is what makes the binding survive a rename on either side.
 *
 * @param {*} value
 * @returns {Number|null}
 */
function parsePonkStream(value) {
  if (typeof value !== 'string') return null;
  const m = /^ponk:(\d+)$/.exec(value);
  return m ? Number(m[1]) : null;
}

/**
 * Whether Ponk frames are weighted by the scanner's dwell.
 *
 * A Ponk frame is geometry before the rasteriser, so without this every path
 * is equally bright however long it is; with it a dot is hot and a crowded
 * frame is dim, as on the real machine. See `laser_dwell.js`.
 */
let dwellModelValue = true;

/**
 * Below this a point counts as blanked -- the beam is off between shapes and
 * while the scanner repositions. A hair above zero so a genuinely dark point
 * is dropped but a dim one is not. Sum of the three colour channels, 0..3.
 */
const LIT_EPSILON = 0.004;

/**
 * How far apart two consecutive points may sit and still be one stroke.
 *
 * In normalised galvo units, so a fraction of the full scan field. A drawn
 * line arrives as points a hair apart; the jump from the end of one figure to
 * the start of the next is a leap across the field. Connecting across that leap
 * is what used to smear a bright sheet between two unrelated strokes.
 */
const JUMP_LIMIT = 0.05;

/** Per-point scratch, so a frame's rebuild allocates nothing. */
const ptFar = new Float32Array(MAX_POINTS * 3);
const ptCol = new Float32Array(MAX_POINTS * 3);
const ptNorm = new Float32Array(MAX_POINTS * 2);
const ptLit = new Uint8Array(MAX_POINTS);
const ptLinked = new Uint8Array(MAX_POINTS);

/**
 * The beam's on-screen width, in pixels.
 *
 * Each point is drawn as its own thin beam from the aperture, so a stationary
 * dot or a lone hot point still shows -- the swept-triangle sheet the beam used
 * to be drew nothing at all for coincident points, which is why a paused figure
 * or a held dot vanished. A pixel width rather than a world one keeps a laser
 * pencil-thin at any distance, and never thinner than the raster can show.
 */
const BEAM_WIDTH_PIXELS = 2.5;

/**
 * The beam material: additive, unlit, coloured per vertex from the stream and
 * textured by the shared haze field.
 *
 * A pencil beam has no surface to shade -- what the eye sees is light scattered
 * out of it by haze in the air, so a beam in still, even air is a flat streak
 * and a beam in real haze turns and mottles. This samples the **same baked
 * volume the mover beams and LED glows do** (`fogging()` from
 * `haze_noise.js`), at each fragment's world position, with the same
 * `worldPos / hazeScale` coordinate and `time * turbulence / 30` drift the
 * movers use -- so a laser sheet shows the identical turning noise, at the same
 * scale, and the one haze scale slider governs all of them.
 *
 * The field always modulates, floored so a beam is faintly visible even with
 * the haze low; `hazeAmount` scales the overall level and `scatterGain` is the
 * debug ride over the top. Wired through `hazeShaderPrelude()`, which prepends
 * the HAZE_* defines, the volume sampler and `fogging` ahead of this body --
 * `sampler3D` needs GLSL ES 3.00, which three compiles a ShaderMaterial as
 * automatically; do not set `glslVersion`, see [[beam-haze-model]].
 *
 * `acolor`/`adist` rather than three's built-in `color`: vertex colours are not
 * enabled on this material, so the names are the fixture's own.
 */
/**
 * A beam material for one laser.
 *
 * Per laser rather than shared, because each carries its own depth tile: the
 * fragment projects its world position into the laser's aperture-view depth
 * map and discards anything past the first surface, so the beam ends where the
 * light would actually stop rather than running through walls. Everything else
 * -- additive, double-sided, haze-textured -- is common; the shared knobs are
 * pushed onto every material each frame.
 *
 * `#include <packing>` brings in `unpackRGBAToDepth`, matching the RGBA depth
 * the atlas writes. `sampler3D` (the haze volume) needs GLSL ES 3.00, which
 * three compiles a ShaderMaterial as; do not set `glslVersion`.
 *
 * @returns {THREE.ShaderMaterial}
 */
function makeBeamMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Both sides: a swept triangle is a thin flat sheet with no inside, so
    // drawing both faces is a uniform doubling (a brightness scale), not the
    // 2:1 rim step DoubleSide gave the mover's open cone.
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    dithering: true,
    uniforms: {
      // Named as the mover beam names them, fed from the same SceneEnv.
      fogState: { value: SceneEnv.hazeEnabled },
      fogFactor: { value: SceneEnv.hazeAmount },
      fogScale: { value: SceneEnv.hazeScale },
      fogTurbulence: { value: SceneEnv.hazeTurbulence },
      time: { value: 0.0 },
      scatterGain: { value: scatterGainValue },
      beamTail: { value: beamTailValue },
      // Where the light starts, so a fragment knows which way its beam runs.
      beamOrigin: { value: new THREE.Vector3() },
      scatterAmount: { value: scatterAmountValue },
      hazeBase: { value: hazeBaseValue },
      // The viewport, so a beam can be given a constant width in pixels.
      resolution: { value: new THREE.Vector2(1, 1) },
      beamWidth: { value: BEAM_WIDTH_PIXELS },
      // This laser's depth tile: the atlas, where its tile sits, and the
      // world-to-clip matrix of its aperture camera. `depthReady` gates it, so
      // a beam with no tile yet is simply not truncated rather than vanishing.
      depthAtlas: { value: null },
      depthMatrix: { value: new THREE.Matrix4() },
      depthTile: { value: new THREE.Vector4(0, 0, 1, 1) },
      depthReady: { value: false },
      depthView: { value: new THREE.Matrix4() },
      depthFar: { value: 120 },
      // Metres now that the compare is linear, not window-depth thousandths.
      depthBias: { value: 0.05 },
      ...hazeUniforms(),
    },
    vertexShader: /* glsl */`
      attribute vec3 acolor;
      attribute float adist;
      attribute vec3 aOther;
      attribute float aSide;
      uniform vec2 resolution;
      uniform float beamWidth;
      varying vec3 vColor;
      varying float vDist;
      varying vec3 vWorld;
      void main() {
        vColor = acolor;
        vDist = adist;
        // The true world position, for the haze and depth reads: the pixel
        // offset below is far too small to matter to either.
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        // Billboard the ribbon: expand this endpoint sideways from the beam's
        // screen-space direction by a fixed pixel width, so a beam is a constant
        // thin line however far away and never narrower than a pixel.
        mat4 mvp = projectionMatrix * viewMatrix * modelMatrix;
        vec4 here = mvp * vec4(position, 1.0);
        vec4 there = mvp * vec4(aOther, 1.0);
        vec2 sHere = (here.xy / here.w) * resolution;
        vec2 sThere = (there.xy / there.w) * resolution;
        vec2 dir = sHere - sThere;
        float len = max(length(dir), 1e-4);
        vec2 perp = vec2(-dir.y, dir.x) / len;
        vec2 offsetPx = perp * aSide * (beamWidth * 0.5);
        here.xy += (offsetPx / resolution) * 2.0 * here.w;
        gl_Position = here;
      }
    `,
    fragmentShader: `${hazeShaderPrelude()}
      #include <packing>
      varying vec3 vColor;
      varying float vDist;
      varying vec3 vWorld;
      uniform bool fogState;
      uniform float fogFactor;
      uniform float fogScale;
      uniform float fogTurbulence;
      uniform float time;
      uniform float scatterGain;
      uniform float beamTail;
      uniform vec3 beamOrigin;
      uniform float scatterAmount;

      // Real haze, measured rather than chosen: a tight forward lobe, a weak
      // one straight back, and a ceiling because the true forward-to-side ratio
      // runs past a hundred and would only clip to white.
      const float PHASE_FORWARD = 0.75;
      const float PHASE_BACKWARD = -0.35;
      const float PHASE_BACK_WEIGHT = 0.12;
      const float PHASE_CEILING = 24.0;

      /**
       * Henyey-Greenstein: how much light a haze particle throws at an angle.
       *
       * g is how forward-biased the scattering is, 0 being even in every
       * direction and approaching 1 a tight forward spike. Negative g turns the
       * lobe around and points it back the way the light came.
       */
      float hg(float c, float g) {
        float g2 = g * g;
        float d = max(1.0 + g2 - 2.0 * g * c, 1e-4);
        return (1.0 - g2) / (12.5663706 * pow(d, 1.5));
      }
      uniform float hazeBase;
      uniform sampler2D depthAtlas;
      uniform mat4 depthMatrix;
      uniform vec4 depthTile;
      uniform bool depthReady;
      uniform mat4 depthView;
      uniform float depthFar;
      uniform float depthBias;
      void main() {
        // Stop at the first surface. The fragment's world position, projected
        // into the aperture camera, gives its place and depth in that view; the
        // atlas holds the nearest surface's depth along the same ray. Past it,
        // the light never arrived -- discard. One texture read, no march.
        if (depthReady) {
          vec4 clip = depthMatrix * vec4(vWorld, 1.0);
          if (clip.w > 0.0) {
            vec3 ndc = clip.xyz / clip.w;
            vec2 tileUv = ndc.xy * 0.5 + 0.5;
            if (tileUv.x > 0.0 && tileUv.x < 1.0 && tileUv.y > 0.0 && tileUv.y < 1.0) {
              vec2 atlasUv = depthTile.xy + tileUv * depthTile.zw;
              // Both sides in metres: the atlas holds view distance over far.
              float surface = unpackRGBAToDepth(texture2D(depthAtlas, atlasUv)) * depthFar;
              float here = -(depthView * vec4(vWorld, 1.0)).z;
              // Past the first surface the light never arrived. An empty scene
              // reads far (1), so nothing is cut; a close floor reads its real
              // depth now that the near plane is small enough to resolve it.
              if (here > surface + depthBias) discard;
            }
          }
        }
        // A gentle fade down the shaft, not a peak at the aperture: the apex is
        // one fixed world point, so all the haze movement is out along the beam.
        //
        // The tail matters as much as the slope. A shaft that merely dims to
        // some fraction and then stops has a visible cut across it where the
        // geometry runs out -- an edge in mid-air that nothing in the scene
        // explains. Taking it to nothing over the last stretch means a beam
        // that meets no surface simply thins away.
        float d = clamp(vDist, 0.0, 1.0);
        float tail = clamp(beamTail, 0.01, 0.99);
        float falloff = (1.0 - 0.5 * d) * (1.0 - smoothstep(1.0 - tail, 1.0, d));
        // The mover beam's coordinate and drift, so the noise reads at one scale
        // across the scene and a sweeping sheet cuts a live cross-section.
        float drift = time * fogTurbulence / 30.0;
        float field = fogging(vWorld / max(fogScale, 0.01), drift);
        // Base plus variation, never black-to-white.
        float haze = mix(hazeBase, 1.0, clamp(field, 0.0, 1.0));
        // Floored so the beam is faintly visible with the haze low.
        float density = fogState ? max(clamp(fogFactor, 0.0, 1.0), 0.05) : 0.05;
        // A beam is brightest when it is coming at you.
        //
        // Haze droplets are large next to the wavelength, so the light they
        // scatter is thrown overwhelmingly *forwards*: look nearly into a beam
        // and what reaches the eye has been deflected by only a few degrees,
        // where the phase function is enormous. Side on is ninety degrees --
        // its minimum -- and so the dimmest a beam ever looks. There is a
        // second, weaker lobe straight back the way the light came, which is
        // why a beam pointing away from you still reads brighter than the same
        // beam crossing your view. Two Henyey-Greenstein lobes give all three.
        vec3 travel = normalize(vWorld - beamOrigin);
        vec3 toEye = normalize(cameraPosition - vWorld);
        float cosTheta = dot(travel, toEye);
        float lobes = mix(hg(cosTheta, PHASE_FORWARD), hg(cosTheta, PHASE_BACKWARD),
          PHASE_BACK_WEIGHT);
        float sideOn = mix(hg(0.0, PHASE_FORWARD), hg(0.0, PHASE_BACKWARD),
          PHASE_BACK_WEIGHT);
        // Anchored at the head-on peak, not at side-on.
        //
        // Both put the same shape on the beam, but normalising to side-on made
        // every angle except exactly perpendicular *brighter* than before -- at
        // forty-five degrees already five times -- so the whole scene lifted and
        // no amount of turning the gain down fixed it. Dividing by the peak
        // instead leaves a beam aimed at the eye exactly where the brightness
        // was tuned and lets every other angle fall away below it. The control
        // is then how far they fall, and it can only ever darken.
        float ratio = mix(1.0, PHASE_CEILING, clamp(scatterAmount, 0.0, 1.0));
        float phase = min(lobes / max(sideOn, 1e-6), ratio) / ratio;

        vec3 c = vColor * falloff * haze * density * scatterGain * phase;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
}

class Laser {
  /**
   * @param {Object} data
   * @param {Object} data.params laser parameters, see `generic/laser.js`
   * @param {Function} [data.settingsAt] () => the placement's LaserSettings
   */
  constructor(data = {}) {
    this._params = data.params || {};
    // A getter rather than the object, so the panel can edit settings in place
    // and this sees the new value on the next refresh. Null for a laser built
    // without a placement behind it.
    this._settingsAt = data.settingsAt || (() => null);
    this._position = new THREE.Vector3();
    this._rotation = new THREE.Vector3();
    this.fixtureHandle = null;
    this._highlighted = false;

    // The transform node the gizmo and the bounding box attach to. Every
    // renderer offers one; it is how selection knows where a fixture is.
    this._dummy = new THREE.Object3D();
    SceneManager.add(this._dummy);

    this._body = new THREE.Mesh(BOX_GEOMETRY, BODY_MATERIAL);
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);

    this._aperture = new THREE.Mesh(APERTURE_GEOMETRY, APERTURE_MATERIAL);
    this._aperture.userData.pickOwner = this;
    this._dummy.add(this._aperture);

    this._outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(BOX_GEOMETRY),
      HIGHLIGHT_MATERIAL,
    );
    this._outline.visible = false;
    this._dummy.add(this._outline);

    this._aim = new THREE.LineSegments(new THREE.BufferGeometry(), AIM_MATERIAL);
    this._aim.visible = false;
    this._dummy.add(this._aim);

    // The beam: swept triangles from the aperture, rebuilt each frame from the
    // point stream. Authored in the fixture's own space and parented to the
    // dummy, so its transform aims the whole figure. Buffers are allocated once
    // at capacity and rewritten in place.
    // Each point is a ribbon: a two-triangle quad, six vertices. Its near edge
    // sits at the aperture, its far edge at the ray's far end, and the vertex
    // shader billboards it to a fixed pixel width. `aOther` carries the ribbon's
    // opposite end so the shader can find its screen direction; `aSide` is which
    // edge (-1 / +1) a vertex belongs to.
    this._beamGeo = new THREE.BufferGeometry();
    const verts = MAX_POINTS * 6;
    this._beamPos = new Float32Array(verts * 3);
    this._beamOther = new Float32Array(verts * 3);
    this._beamColor = new Float32Array(verts * 3);
    this._beamDist = new Float32Array(verts);
    this._beamSide = new Float32Array(verts);
    const dyn = (arr, size) => new THREE.BufferAttribute(arr, size)
      .setUsage(THREE.DynamicDrawUsage);
    this._beamGeo.setAttribute('position', dyn(this._beamPos, 3));
    this._beamGeo.setAttribute('aOther', dyn(this._beamOther, 3));
    this._beamGeo.setAttribute('acolor', dyn(this._beamColor, 3));
    this._beamGeo.setAttribute('adist', dyn(this._beamDist, 1));
    this._beamGeo.setAttribute('aSide', dyn(this._beamSide, 1));
    this._beamGeo.setDrawRange(0, 0);
    this._beamMaterial = makeBeamMaterial();
    this._beam = new THREE.Mesh(this._beamGeo, this._beamMaterial);
    this._beam.frustumCulled = false;
    this._dummy.add(this._beam);

    // The same frame, as a picture to be thrown onto geometry.
    this._figure = new LaserFigure(MAX_POINTS);
    this._figureSlot = -1;
    this._aperturePos = new THREE.Vector3();
    /** Which named IDN service feeds this laser. */
    this._serviceId = 1;
    /** Which address this laser's device is bound to, from `publishInputs`. */
    this._address = null;
    /** Why it has no device, when another laser holds the one it asked for. */
    this._inputError = null;
    FIGURE_ATLAS.attach(this._figure);

    // The aperture camera the depth atlas draws from, and the fixed basis that
    // turns three's look-down-(-Z) camera into the fixture's look-down-(-Y),
    // +Z-up frame -- the same conversion the projector's lens camera uses.
    this._depthCam = new THREE.PerspectiveCamera();
    this._depthCam.matrixWorldAutoUpdate = false;
    this._basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 1, 0),
    );
    this._depthMatrix = new THREE.Matrix4();
    this._depthSlot = -1;
    this.applyGeometry();
    instances.add(this);
  }

  /**
   * Sizes every part from the profile's numbers.
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
    const aperture = Math.max(Number(params.apertureDiameter) || 0, 0.001);

    // Width across, depth front-to-back, height up -- the box stands the way
    // the machine does.
    this._body.scale.set(width, depth, height);
    this._outline.scale.copy(this._body.scale);

    // The model measures the aperture from the centre of the front panel, seen
    // by someone facing it; same unnegated -Y/+Z convention as the projector's
    // lens. Set a hair proud of the panel so it is not co-planar with it.
    const ap = apertureOrigin(params);
    this._aperture.scale.set(aperture, 1, aperture);
    this._aperture.position.set(ap.x, ap.y - 0.001, ap.z);

    this.buildAim(ap);
  }

  /**
   * Rebuilds the aim line from the aperture, straight along the throw.
   *
   * The scan angles decide how wide the figure *could* be, but the line only
   * shows direction, so it runs down the axis. It is a placement aid; where the
   * light actually goes is the stream's business.
   *
   * @public
   * @param {Object} ap `{ x, y, z }` from `apertureOrigin`
   */
  buildAim(ap) {
    // Forward is -Y. A single segment from the aperture down the axis.
    const points = [ap.x, ap.y, ap.z, ap.x, ap.y - AIM_LENGTH, ap.z];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    if (this._aim.geometry) this._aim.geometry.dispose();
    this._aim.geometry = geometry;
  }

  /**
   * Re-reads geometry after a field changes, and when a channel writes -- which
   * for a laser is the same event seen from two sides.
   *
   * @public
   */
  refresh() {
    this.buildAim(apertureOrigin(this._params || {}));
  }

  /**
   * Which stream this laser draws.
   *
   * The fixture says how it is fed -- its protocol, and for a DAC the address
   * its device is bound to. Ponk is the one that needs a further choice, since
   * one machine receives every MadMapper output at once; on Ponk with no
   * stream picked, the first live one is taken so a freshly placed laser shows
   * something rather than staying dark.
   *
   * @param {Object} settings the placement's LaserSettings, or null
   * @returns {Object|null} `{ protocol, service, address }`
   */
  resolveSource(settings) {
    const protocol = (settings && settings.value('protocol')) || 'ponk';
    const address = (settings && settings.value('address')) || this._address || null;
    if (protocol === 'ponk') {
      const chosen = parsePonkStream(settings ? settings.value('source') : null);
      if (chosen !== null) return { protocol: 'ponk', service: chosen, address: null };
      const live = LaserStream.report().find((r) => r.protocol === 'ponk' && r.held > 0);
      return live ? { protocol: 'ponk', service: live.service, address: null } : null;
    }
    // A DAC's stream is its device: the address it is bound to, and for IDN
    // the service this laser was given on that unit.
    return {
      protocol,
      address,
      service: protocol === 'idn' ? this._serviceId : null,
    };
  }

  /**
   * Rebuilds the beam from the current point stream and output stage.
   *
   * Each consecutive pair of points is a triangle from the aperture out to the
   * two rays' far ends; blanked travel (both ends dark) draws nothing. The
   * output stage -- scale and offset the geometry, balance the colours, dim and
   * blank -- is applied here, on the way in, so the shader stays a plain
   * additive draw.
   *
   * @public
   */
  buildBeam() {
    // The figure is placed by projecting through the aperture camera, and the
    // beam pass has not run yet this frame, so bring that matrix up to date
    // here rather than painting with the previous frame's aim.
    this.updateDepthCamera();
    const settings = this._settingsAt();
    const params = this._params || {};
    const source = this.resolveSource(settings);
    // A Ponk frame is paths, laid out as a DAC run with a blank between paths
    // and a dwell weight per point; a DAC's is the persistence window of what
    // it played. From here down the two are the same points.
    let frame = null;
    let weights = null;
    if (source && source.protocol === 'ponk') {
      const ponk = LaserStream.ponkFrame(source.service);
      if (ponk) {
        frame = flattenPaths(ponk.paths, {
          pointRate: Number(params.maxPointRate) || 0,
          dwell: dwellModelValue,
          maxPoints: MAX_POINTS,
        });
        ({ weights } = frame);
      }
    } else if (source) {
      frame = LaserStream.frame(source.protocol, 50, source.service, source.address);
    }
    const n = Math.min(frame ? frame.count : 0, MAX_POINTS);
    if (n < 1) {
      this._beamGeo.setDrawRange(0, 0);
      this._figure.build({
        n: 0, far: ptFar, col: ptCol, lit: ptLit, linked: ptLinked, clip: scratchClip,
      });
      return;
    }

    const pts = frame.points;
    const { h, v: v0 } = scanHalfAngles(params);
    const ap = apertureOrigin(params);
    const val = (key, fallback) => (settings ? Number(settings.value(key)) : fallback);
    const gain = settings ? settings.gain : 1;
    const red = (val('red', 100) / 100) * gain;
    const green = (val('green', 100) / 100) * gain;
    const blue = (val('blue', 100) / 100) * gain;
    const xScale = val('xScale', 100) / 100;
    const yScale = val('yScale', 100) / 100;
    const xPos = val('xPos', 0) / 100;
    const yPos = val('yPos', 0) / 100;
    // Mounting flips, the way a real projector offers them: a laser hung
    // upside down or firing at a mirror needs its field turned over without
    // the content being re-authored.
    const mirrorX = settings ? !!settings.value('mirrorX') : false;
    const mirrorY = settings ? !!settings.value('mirrorY') : false;

    const pos = this._beamPos;
    const other = this._beamOther;
    const colour = this._beamColor;
    const dist = this._beamDist;
    const side = this._beamSide;
    const capacity = MAX_POINTS * 6;
    let v = 0;

    const putR = (x, y, z, ox, oy, oz, c3, d, sd) => {
      if (v >= capacity) return;
      const p3 = v * 3;
      pos[p3] = x; pos[p3 + 1] = y; pos[p3 + 2] = z;
      other[p3] = ox; other[p3 + 1] = oy; other[p3 + 2] = oz;
      colour[p3] = ptCol[c3]; colour[p3 + 1] = ptCol[c3 + 1]; colour[p3 + 2] = ptCol[c3 + 2];
      dist[v] = d; side[v] = sd;
      v += 1;
    };
    // Sheet vertices carry no billboard: `aSide` 0 leaves the offset at zero.
    const putS = (x, y, z, c3, d) => putR(x, y, z, x, y, z, c3, d, 0);

    // Every point resolved once: is it lit, where does its ray end, what colour.
    for (let i = 0; i < n; i += 1) {
      const b = i * POINT_STRIDE;
      // Dwell: how long the scanner would have lingered here, relative to a
      // line across the field. 1 for a DAC stream, whose points carry it.
      const w = weights ? weights[i] : 1;
      const cr = (pts[b + 2] / 65535) * red * w;
      const cg = (pts[b + 3] / 65535) * green * w;
      const cb = (pts[b + 4] / 65535) * blue * w;
      // Signed galvo positions carried as their 16-bit bit pattern, to -1..1.
      const rawX = ((pts[b] << 16) >> 16) / 32768;
      const rawY = ((pts[b + 1] << 16) >> 16) / 32768;
      // Position moves within the headroom the scale leaves: an 80% pattern
      // can travel over the remaining 20%, and never off the field.
      const sx = mirrorX ? -rawX : rawX;
      const sy = mirrorY ? -rawY : rawY;
      const nx = Math.min(Math.max(sx * xScale + xPos * (1 - xScale), -1), 1);
      const ny = Math.min(Math.max(sy * yScale + yPos * (1 - yScale), -1), 1);
      const ax = nx * h;
      const ay = ny * v0;
      const cosAx = Math.cos(ax);
      const cosAy = Math.cos(ay);
      // Forward is -Y and +Z up, so the throw's own right hand -- forward
      // crossed with up -- points along world -X. ILDA has positive X deflect
      // to the right in front projection, so a positive galvo value goes to
      // -X. Sending it to +X drew every figure mirrored, which reads as
      // nothing much until there is text in the content.
      const i3 = i * 3;
      ptFar[i3] = ap.x - Math.sin(ax) * cosAy * beamLengthValue;
      ptFar[i3 + 1] = ap.y - cosAx * cosAy * beamLengthValue;
      ptFar[i3 + 2] = ap.z + cosAx * Math.sin(ay) * beamLengthValue;
      ptCol[i3] = cr; ptCol[i3 + 1] = cg; ptCol[i3 + 2] = cb;
      ptNorm[i * 2] = nx; ptNorm[i * 2 + 1] = ny;
      ptLit[i] = cr + cg + cb > LIT_EPSILON ? 1 : 0;
      ptLinked[i] = 0;
    }

    // The stroke itself: the surface a moving beam sweeps between one point and
    // the next. A straight line drawn by the scanner is one continuous sheet,
    // not a row of separate blades -- which is what per-point ribbons alone
    // produced. Two rays from a single aperture span a triangle, so each
    // consecutive pair contributes one and a run of points becomes a fan.
    for (let i = 0; i + 1 < n; i += 1) {
      const dx = ptNorm[(i + 1) * 2] - ptNorm[i * 2];
      const dy = ptNorm[(i + 1) * 2 + 1] - ptNorm[i * 2 + 1];
      // Blanked travel between figures must not be bridged.
      const joined = dx * dx + dy * dy <= JUMP_LIMIT * JUMP_LIMIT;
      if (ptLit[i] && ptLit[i + 1] && joined) {
        ptLinked[i] = 1;
        ptLinked[i + 1] = 1;
        const a3 = i * 3;
        const b3 = (i + 1) * 3;
        putS(ap.x, ap.y, ap.z, a3, 0);
        putS(ptFar[a3], ptFar[a3 + 1], ptFar[a3 + 2], a3, 1);
        putS(ptFar[b3], ptFar[b3 + 1], ptFar[b3 + 2], b3, 1);
      }
    }

    // What the sheet cannot show: a held dot, or a hot point standing alone
    // between blanked travel. Those keep a billboarded ribbon so they never
    // fall below a pixel and vanish.
    for (let i = 0; i < n; i += 1) {
      if (ptLit[i] && !ptLinked[i]) {
        const i3 = i * 3;
        const fx = ptFar[i3];
        const fy = ptFar[i3 + 1];
        const fz = ptFar[i3 + 2];
        putR(ap.x, ap.y, ap.z, fx, fy, fz, i3, 0, -1);
        putR(ap.x, ap.y, ap.z, fx, fy, fz, i3, 0, 1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, i3, 1, 1);
        putR(ap.x, ap.y, ap.z, fx, fy, fz, i3, 0, -1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, i3, 1, 1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, i3, 1, -1);
      }
    }

    this._beamGeo.setDrawRange(0, v);

    // The picture, from the same points, the same lit test and the same jump
    // guard the sheet above was built from -- so the figure on the wall and the
    // beams in the air are the same figure, not two that have to be kept in step.
    this._beamMaterial.uniforms.beamOrigin.value
      .setFromMatrixPosition(this._depthCam.matrixWorld);
    scratchClip.copy(this._depthMatrix).multiply(this._dummy.matrixWorld);
    this._figure.build({
      n, far: ptFar, col: ptCol, lit: ptLit, linked: ptLinked, clip: scratchClip,
    });
    this._beamGeo.attributes.position.needsUpdate = true;
    this._beamGeo.attributes.aOther.needsUpdate = true;
    this._beamGeo.attributes.acolor.needsUpdate = true;
    this._beamGeo.attributes.adist.needsUpdate = true;
    this._beamGeo.attributes.aSide.needsUpdate = true;
  }

  /**
   * Aims the aperture depth camera and rebuilds its world-to-clip matrix.
   *
   * A perspective camera at the aperture, looking down the throw with the fixed
   * basis, its frustum covering the full scan: vertical fov is the whole scan
   * height and the aspect the ratio of the two half-angle tangents, so an
   * asymmetric scanner still maps square. Matrices are set by hand and the
   * automatic pass is off, for the same reason the projector's are -- three
   * would otherwise rebuild them from an untouched position.
   *
   * @public
   */
  updateDepthCamera() {
    const params = this._params || {};
    const ap = apertureOrigin(params);
    const { h, v } = scanHalfAngles(params);
    this._dummy.updateMatrixWorld();
    this._depthCam.matrixWorld
      .makeTranslation(ap.x, ap.y, ap.z)
      .multiply(this._basis)
      .premultiply(this._dummy.matrixWorld);
    this._depthCam.matrixWorldInverse.copy(this._depthCam.matrixWorld).invert();
    this._depthCam.fov = Math.max(1, 2 * v * (180 / Math.PI));
    this._depthCam.aspect = Math.tan(Math.max(h, 1e-3)) / Math.tan(Math.max(v, 1e-3));
    this._depthCam.near = LASER_DEPTH.near;
    this._depthCam.far = LASER_DEPTH.far;
    this._depthCam.updateProjectionMatrix();
    this._depthMatrix
      .copy(this._depthCam.projectionMatrix)
      .multiply(this._depthCam.matrixWorldInverse);
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
   * Nothing here depends on the address, so a repatch changes nothing today.
   *
   * Present because `Fixture.notifyRepatched` calls it on any renderer that
   * offers it.
   *
   * @public
   */
  // eslint-disable-next-line class-methods-use-this
  repatch() {}

  /**
   * Grows a box to contain this laser's body.
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
   * How far the body reaches below the fixture's origin: half its height,
   * since local +Z is up.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    return (Number((this._params || {}).height) || 0) / 2;
  }

  /**
   * Shows or hides the outline and the aim line together.
   *
   * @public
   * @param {Boolean} state
   */
  showAids(state) {
    this._outline.visible = !!state;
    this._aim.visible = !!state;
  }

  /**
   * Marks this laser as the single selected fixture.
   *
   * @public
   * @param {Boolean} state
   */
  setSinglyHighlighted(state) {
    this.showAids(state);
  }

  /**
   * Whether this laser is part of a multi-selection.
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
   * The scan half-angles, in radians -- what the beam renderer will map the
   * DAC's full scale onto. Exposed here so a later step reads it off the model
   * rather than the profile.
   *
   * @public
   * @returns {Object} `{ h, v }`
   */
  scanAngles() {
    return scanHalfAngles(this._params || {});
  }

  /**
   * Drops a laser and everything it owns.
   *
   * Shared geometries and materials are left alone -- they belong to the
   * module. The outline and aim geometries are per-instance and would leak.
   *
   * @static
   * @param {Laser} instance laser to remove
   */
  static deleteInstance(instance) {
    if (!instance) return;
    instances.delete(instance);
    if (instance._aim && instance._aim.geometry) instance._aim.geometry.dispose();
    if (instance._outline && instance._outline.geometry) instance._outline.geometry.dispose();
    if (instance._beamGeo) instance._beamGeo.dispose();
    if (instance._beamMaterial) instance._beamMaterial.dispose();
    if (instance._figure) {
      FIGURE_ATLAS.detach(instance._figure);
      instance._figure.dispose();
    }
    if (instance._dummy) SceneManager.remove(instance._dummy);
  }

  /**
   * Rebuilds every laser's beam from the current stream, once per drawn frame.
   *
   * Called from the render loop beside the other stream-fed renderers. Enables
   * the stream on first use -- the DACs are already listening in the main
   * process; this only starts accumulating what they play.
   *
   * @static
   */
  static update(t) {
    if (!LaserStream.enabled) LaserStream.enable();
    Laser.publishInputs();
    instances.forEach((laser) => {
      const u = laser._beamMaterial.uniforms;
      u.time.value = t || 0;
      // Level with the room every frame, the way the mover beam is kept level,
      // so a laser is never drawn through haze the room does not have.
      u.fogState.value = SceneEnv.hazeEnabled;
      u.fogFactor.value = SceneEnv.hazeAmount;
      u.fogScale.value = SceneEnv.hazeScale;
      u.fogTurbulence.value = SceneEnv.hazeTurbulence;
      u.scatterGain.value = scatterGainValue;
      u.beamTail.value = beamTailValue;
      u.scatterAmount.value = scatterAmountValue;
      u.hazeBase.value = hazeBaseValue;
      laser.buildBeam();
    });
  }

  /**
   * What the surface pass needs to paint each laser's figure onto geometry.
   *
   * Gathered here rather than reached for by the pass, so the pass stays
   * ignorant of the fixture layer. Only lasers holding both a depth tile and a
   * figure tile are offered: without either there is nothing to project or no
   * way to know what is in the way.
   *
   * @public
   * @returns {Array} each `{ matrix, depthTile, figureTile, position, power }`
   */
  static projections() {
    const out = [];
    instances.forEach((laser) => {
      if (laser._depthSlot < 0 || laser._figureSlot < 0) return;
      out.push({
        matrix: laser._depthMatrix,
        depthTile: LASER_DEPTH.tileUv(laser._depthSlot),
        figureTile: FIGURE_ATLAS.tileUv(laser._figureSlot),
        position: laser._aperturePos.setFromMatrixPosition(laser._depthCam.matrixWorld),
        power: Math.max(Number((laser._params || {}).power) || 0, 0) * surfaceGainValue,
      });
    });
    return out;
  }

  /** @public @returns {Object|null} the figure atlas texture */
  static figureTexture() {
    return FIGURE_ATLAS.texture();
  }

  /** @public @returns {Object|null} the laser depth atlas texture */
  static depthTexture() {
    return LASER_DEPTH.texture();
  }

  /** @public @returns {Number} the range the depth atlas is packed against */
  static depthFar() {
    return LASER_DEPTH.far;
  }

  /**
   * Tells the main process how every laser in the show wants to be fed.
   *
   * The show is the source of truth: each laser names its protocol and, for a
   * DAC, the address its device lives at, and the hub starts and stops devices
   * to match. IDN services are numbered per unit, so a rig sharing one IDN
   * address gets one named service each -- the arrangement worth having, and
   * the one MadMapper cannot yet address (see
   * `docs/madmapper-idn-service-map.md`).
   *
   * Sent only when the answer actually changes, since this runs every frame.
   *
   * @public
   */
  static publishInputs() {
    const list = [];
    /** Service numbering restarts per IDN unit, so each unit counts its own. */
    const perUnit = new Map();
    [...instances].forEach((laser, i) => {
      const handle = laser.fixtureHandle;
      const settings = laser._settingsAt();
      const protocol = (settings && settings.value('protocol')) || 'ponk';
      const address = (settings && settings.value('address')) || null;
      const name = (handle && handle.name) || `Laser ${i + 1}`;
      let service = null;
      if (protocol === 'idn') {
        const unit = `idn@${address || 'default'}`;
        const at = (perUnit.get(unit) || 0) + 1;
        perUnit.set(unit, at);
        service = at > MAX_SERVICES ? -1 : at;
      }
      laser._serviceId = service === null ? 1 : service;
      // Replaced by the resolved one once the hub answers; null until then.
      laser._address = address;
      list.push({
        uid: (handle && handle.uid) || `laser-${i}`, name, protocol, address, service,
      });
    });
    const signature = JSON.stringify(list);
    if (signature === lastInputs) return;
    lastInputs = signature;
    Promise.resolve(LaserStream.configure(list)).then((results) => {
      // What the hub could not do -- a second laser asking for an Ether Dream
      // another already holds -- so the fixture can say so rather than sit dark.
      const byUid = new Map((results || []).map((r) => [r.uid, r]));
      [...instances].forEach((laser, i) => {
        const handle = laser.fixtureHandle;
        const uid = (handle && handle.uid) || `laser-${i}`;
        const result = byUid.get(uid);
        laser._inputError = result && result.ok === false ? result.reason : null;
        // The address the device is actually bound to, which is what its
        // batches are tagged with -- a laser set to the default stores null.
        if (result && result.address) laser._address = result.address;
      });
    });
  }

  /**
   * Why this laser has no device of its own, if it has none.
   *
   * @public
   * @returns {String|null}
   */
  inputError() {
    return this._inputError || null;
  }

  /**
   * The same, for a fixture handle, so the settings widget can ask without
   * holding a renderer instance.
   *
   * @static
   * @param {Object} fixture
   * @returns {String|null}
   */
  static inputErrorFor(fixture) {
    if (!fixture) return null;
    const laser = [...instances].find((l) => l.fixtureHandle === fixture
      || (l.fixtureHandle && fixture.uid && l.fixtureHandle.uid === fixture.uid));
    return laser ? laser.inputError() : null;
  }

  /**
   * Draws every laser's picture into the figure atlas.
   *
   * Redrawn every frame and never cached, unlike the depth: the content is the
   * whole point. Cheap -- a frame is a few thousand short strokes into a small
   * target, and the geometry was already built alongside the beam.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   */
  static renderFigures(renderer) {
    const list = [...instances];
    if (!list.length) return;
    const entries = [];
    list.forEach((laser, i) => {
      if (i >= FIGURE_ATLAS.maxTiles) {
        laser._figureSlot = -1;
        return;
      }
      laser._figureSlot = i;
      entries.push({ slot: i, figure: laser._figure });
    });
    FIGURE_ATLAS.render(renderer, entries);
  }

  /**
   * Draws every laser's depth from its aperture and hands each its tile, so the
   * beam fragment can stop at the first surface. Called once per frame after the
   * projectors' own depth pass; lasers barely move, so this is a candidate for
   * caching later, but rendering it each frame is correct and cheap for a
   * handful of fixtures.
   *
   * @static
   * @param {Object} renderer
   * @param {Object} scene
   */
  static renderDepth(renderer, scene) {
    if (!OCCLUSION_ENABLED) return;
    const list = [...instances];
    if (!list.length) return;
    // The viewport, so the beam ribbons keep a constant pixel width. Set here
    // because this is the per-frame call that has the renderer to hand.
    renderer.getSize(scratchResolution);
    list.forEach((laser) => {
      laser._beamMaterial.uniforms.resolution.value.copy(scratchResolution);
    });
    scene.updateMatrixWorld();
    const projections = [];
    list.forEach((laser, i) => {
      if (i >= LASER_DEPTH.maxProjections) {
        laser._depthSlot = -1;
        return;
      }
      laser.updateDepthCamera();
      laser._depthSlot = i;
      projections.push({ camera: laser._depthCam });
    });
    // Nothing moved: last frame's tile is still exactly right.
    //
    // Every laser redraws the whole scene into its own tile, so a sixteen-laser
    // rig would be sixteen full passes a frame -- to reproduce, in a bolted-down
    // rig in a still room, the identical image each time. `DepthAtlas.render`
    // hashes the scene and each aperture camera and redraws a tile only when the
    // result would differ, clearing that tile alone, so one laser moving among
    // fifteen still ones costs one pass rather than sixteen.

    // A laser's own fixture is not hidden for the pass, and does not need to
    // be: only shadow casters are drawn into the atlas, and nothing on a laser
    // -- body, aperture, aim, beam -- sets `castShadow`. Hiding them was
    // guarding against a chassis cutting its own beam off at the muzzle, which
    // could not happen. If a laser body is ever made to cast, this is where the
    // fixture has to stand down again.
    LASER_DEPTH.render(renderer, scene, projections);
    const texture = LASER_DEPTH.texture();
    list.forEach((laser) => {
      const u = laser._beamMaterial.uniforms;
      if (laser._depthSlot < 0) {
        u.depthReady.value = false;
        return;
      }
      const tile = LASER_DEPTH.tileUv(laser._depthSlot);
      u.depthAtlas.value = texture;
      u.depthMatrix.value.copy(laser._depthMatrix);
      u.depthView.value.copy(laser._depthCam.matrixWorldInverse);
      u.depthFar.value = LASER_DEPTH.far;
      u.depthTile.value.set(tile.x, tile.y, tile.width, tile.height);
      u.depthReady.value = true;
    });
  }

  /**
   * Scatter gain, for the debug panel: how brightly a beam scatters out of the
   * air per unit haze. A single knob over every laser at once.
   *
   * @static
   * @param {Number} gain
   */
  /**
   * How hard the figure is painted onto geometry.
   *
   * Rides on top of the surface pass's own calibration, so this is a multiplier
   * a designer moves rather than the constant that anchors it.
   *
   * @public
   * @param {Number} gain
   */
  static setSurfaceGain(gain) {
    surfaceGainValue = Math.max(Number(gain) || 0, 0);
  }

  /** @public @returns {Number} the figure's brightness multiplier */
  static surfaceGain() {
    return surfaceGainValue;
  }

  /** @public @param {Number} metres how far a beam reaches when it hits nothing */
  static setBeamLength(metres) {
    beamLengthValue = Math.min(Math.max(Number(metres) || 1, 1), 120);
  }

  /** @public @returns {Number} how far a beam reaches when it hits nothing */
  static beamLength() {
    return beamLengthValue;
  }

  /** @public @param {Number} fraction how much of the end fades out */
  static setBeamTail(fraction) {
    beamTailValue = Math.min(Math.max(Number(fraction) || 0, 0.01), 0.99);
  }

  /** @public @returns {Number} the fraction of the shaft given to fading */
  static beamTail() {
    return beamTailValue;
  }

  /**
   * Whether Ponk frames are weighted by scanner dwell. See `laser_dwell.js`.
   *
   * @public
   * @param {Boolean} on
   */
  static setDwellModel(on) {
    dwellModelValue = !!on;
  }

  /** @public @returns {Boolean} */
  static dwellModel() {
    return dwellModelValue;
  }

  /**
   * How much a beam brightens when it is aimed at the viewer.
   *
   * @public
   * @param {Number} amount 0 flat, 1 the full forward spike
   */
  static setScatterAmount(amount) {
    scatterAmountValue = Math.min(Math.max(Number(amount) || 0, 0), 1);
  }

  /** @public @returns {Number} how much of the forward spike is shown */
  static scatterAmount() {
    return scatterAmountValue;
  }

  /** @public @returns {Number} the beam-in-air brightness multiplier */
  static scatterGain() {
    return scatterGainValue;
  }

  /** @public @param {Number} px how wide a drawn stroke is, in tile pixels */
  static setFigureWidth(px) {
    setLineWidth(px);
  }

  /** @public @returns {Number} the drawn stroke width in tile pixels */
  static figureWidth() {
    return lineWidth();
  }

  static setScatterGain(gain) {
    scatterGainValue = Number(gain) || 0;
  }

  /**
   * Haze base, for the debug panel: how much of a beam is a flat base level
   * versus haze variation on top. 0 is pure variation, 1 a flat beam.
   *
   * @static
   * @param {Number} base 0..1
   */
  static setHazeBase(base) {
    hazeBaseValue = Math.min(Math.max(Number(base) || 0, 0), 1);
  }

  /**
   * Drops every laser's highlight.
   *
   * @static
   */
  static clearHighlighting() {
    instances.forEach((laser) => {
      laser._highlighted = false;
      laser.showAids(false);
    });
  }

  /**
   * Objects a raycast should test.
   *
   * @static
   * @returns {Array}
   */
  static pickObjects() {
    const targets = [];
    instances.forEach((laser) => {
      targets.push(laser._body, laser._aperture);
    });
    return targets;
  }

  /**
   * Visits every laser with its world position, for rectangle selection.
   *
   * @static
   * @param {Function} visit called with (fixtureHandle, position)
   */
  static eachSelectable(visit) {
    instances.forEach((laser) => {
      if (laser.fixtureHandle) visit(laser.fixtureHandle, laser._position);
    });
  }
}

export default Laser;
