/* eslint-disable no-bitwise */
// A streamed point's x/y is a signed 16-bit galvo value carried as its bit
// pattern; sign-extending it is the subject matter, not an accident.
import * as THREE from 'three';
import { THRU_PROTOCOL, THRU_PREFIX } from '@/models/DMX/laser_settings';
import SceneManager from './scene_manager';
import SceneEnv from './scene_env';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import { DepthAtlas } from './projector_depth';
import { flattenPaths } from './laser_dwell';
import { clipFrame, clipStatus } from './laser_clip_player';
import FIGURE_ATLAS, { LaserFigure, FIGURE_PIXEL, FIGURE_MIN_PIXELS } from './laser_figure';
import LaserStream, { POINT_STRIDE } from '../laser_stream';
import {
  DEFAULT_LASER_PARAMS, apertureOrigin, apertureSize, scanHalfAngles, laserChannelLumens,
} from '../../models/DMX/generic/laser';
import { HAZE_SCATTER_AT_FULL, HAZE_EXTINCTION_AT_FULL } from './light';
import { SCENE_PER_NIT } from './light_field';
import { laserAppearance, whiteBalance } from './laser_appearance';
import BodyFinish from './body_finish';
import { castsContactShadow } from './contact_shadows';
import { setOutlined } from './selection_outline';

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
 * Luminance of each sRGB primary at 1.0 (Rec. 709). A laser line is drawn as
 * its primary at the luminance its lumens give, so a colour's flux divided by
 * its primary's luminance is what goes in that channel.
 */
const PRIMARY_LUMINANCE = { red: 0.2126, green: 0.7152, blue: 0.0722 };

/** Scratch for the halo draw: the clear colour and the beam's resolution. */
const haloClearColor = new THREE.Color();
const haloResolution = new THREE.Vector2();

/**
 * How much the haze texture modulates a beam, as the mover beam's
 * `BEAM_FIELD_DEPTH`: the field varies the air by half either way.
 */
const HAZE_FIELD_DEPTH = 0.5;

/**
 * Debug-panel multipliers over the photometric result, 0 to 10: one for the
 * beams in the air, one for the figure on surfaces. 1 is the physics; the
 * defaults are set by eye against real lasers.
 */
const GAIN_MAX = 10;
let beamGainValue = 5;
let figureGainValue = 1.8;

/**
 * The widest half-angle the aperture camera covers, in radians: 85 degrees.
 *
 * The depth tile and the figure tile are one perspective view each, which
 * cannot reach 90 degrees off the axis. A wider scanner -- a 37 degree laser
 * behind a 5x lens fans out to 185 -- still draws its beams to the full angle;
 * past this they are not stopped by surfaces and leave no figure on them.
 */
const FIELD_HALF_MAX = (85 * Math.PI) / 180;

/**
 * The tangents of the half-angles the aperture camera covers: the scan's,
 * capped at `FIELD_HALF_MAX`.
 *
 * @param {Object} params laser parameters
 * @returns {Object} `{ tanH, tanV }`
 */
function fieldTangents(params) {
  const { h, v } = scanHalfAngles(params);
  return {
    tanH: Math.tan(Math.min(h, FIELD_HALF_MAX)),
    tanV: Math.tan(Math.min(v, FIELD_HALF_MAX)),
  };
}

/** Scratch, reused each frame so `update` allocates nothing. */
const scratchResolution = new THREE.Vector2();

/** Local space to the aperture camera's clip space, for placing the figure. */
const scratchClip = new THREE.Matrix4();

/**
 * Whether beams are truncated at the first surface via the aperture depth pass.
 *
 * It relies on two things in `projector_depth.js`. The scene's background
 * stands down for the pass -- `WebGLBackground` would otherwise clear-blit it
 * into every atlas tile, empty sky would unpack to a surface about 22 m out,
 * and beams would be cut against open air. And the atlas packs linear view
 * distance taken from `gl_FragCoord.z`, which the rasteriser computes after
 * clipping -- `MeshDepthMaterial` derives depth from an interpolated varying,
 * and a ground plane of two triangles running from behind the camera to far in
 * front makes that varying meaningless, so the floor would pack as noise.
 *
 * A debug-panel switch, not a preference: off, every beam runs its full length
 * whatever is in the way, which is how a cut that should not be there is told
 * apart from a surface that is.
 */
let occlusionEnabled = true;

/** Set by the debug panel; the next depth pass reads its tiles back and logs them. */
let depthDumpPending = false;

/** Texels sampled across a tile when it is logged as numbers. */
const DEPTH_DUMP_GRID = 24;

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

/**
 * The aperture window, a unit square scaled to its width and height. A plane
 * faces +Z, and the beam leaves along -Y.
 */
const APERTURE_GEOMETRY = new THREE.PlaneGeometry(1, 1);
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
 * The near-black is the default; a definition may pick its own colour.
 */
const BODY = new BodyFinish({
  colour: DEFAULT_LASER_PARAMS.bodyColor,
  roughness: 0.5,
  metalness: 0.3,
  lift: 0.6,
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
 * How long a beam is drawn, in metres. The depth atlas stops it at the first
 * surface; in open air extinction and distance dim it, and this matches the
 * atlas's range.
 */
const BEAM_LENGTH = 120;

/**
 * Most points a beam holds at once, matching the stream's ring.
 *
 * One triangle spans each consecutive pair, so the geometry is sized for one
 * fewer triangle than this and updated in place every frame rather than
 * reallocated.
 */
// Room for Ponk, where one circle arrives as 8,146 points. This is the frame's
// whole budget, not a cut: `flattenPaths` spreads it over the
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
 * would smear a bright sheet between two unrelated strokes.
 */
const JUMP_LIMIT = 0.05;

/** Per-point scratch, so a frame's rebuild allocates nothing. */
const ptFar = new Float32Array(MAX_POINTS * 3);
const ptFlux = new Float32Array(MAX_POINTS * 3);
const ptNorm = new Float32Array(MAX_POINTS * 2);
const ptLit = new Uint8Array(MAX_POINTS);
const ptLinked = new Uint8Array(MAX_POINTS);
/** Whether point i and point i + 1 are one stroke. */
const ptJoined = new Uint8Array(MAX_POINTS);

/**
 * The narrowest a held dot's beam is drawn, in pixels. A beam is a few
 * millimetres across and the eye resolves it at its own luminance, so it is
 * drawn at its real width down to one pixel and its light spread no wider;
 * the camera's glare widens what is bright, as the eye's does.
 */
const BEAM_WIDTH_PIXELS = 1;

/**
 * A beam material for one laser: light scattered out of the beam by the haze,
 * as the mover beam does it.
 *
 * Single scattering in candela. A volume of air with scattering coefficient
 * sigma (`HAZE_SCATTER_AT_FULL` times the haze amount), lit by a beam of flux
 * F, sends sigma F p(theta) candela per metre of beam towards the eye, p being
 * the haze's phase function per steradian (`hazeLobes`). What reaches the eye
 * is that, dimmed by extinction over the beam's path from the aperture and the
 * path to the eye, and textured by the haze field.
 *
 * Two kinds of geometry carry it. A **sheet** triangle is the stroke the
 * scanner sweeps between two points: its vertices carry the flux per radian of
 * sweep, which at distance s from the aperture is spread over s metres, and a
 * view ray crossing the sheet at |n.v| to its normal sees it over 1/|n.v| of
 * that. A **dot** ribbon is a held point's beam: a line source, its flux over
 * its width, brighter by 1/sin of the angle the view makes with it. The width
 * is the beam's own (diameter plus divergence times distance) or the drawn
 * width in pixels, whichever is wider, so the light is never more concentrated
 * on screen than it is drawn.
 *
 * Per laser rather than shared, because each carries its own depth tile: the
 * fragment projects its world position into the laser's aperture-view depth
 * map and discards anything past the first surface.
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
    // Both sides: a sheet is flat and has no inside.
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    dithering: true,
    defines: {
      HAZE_FIELD_DEPTH: HAZE_FIELD_DEPTH.toFixed(3),
      SCENE_PER_NIT: SCENE_PER_NIT.toFixed(6),
    },
    uniforms: {
      // Named as the mover beam names them, fed from the same SceneEnv.
      fogState: { value: SceneEnv.hazeEnabled },
      fogFactor: { value: SceneEnv.hazeAmount },
      fogScale: { value: SceneEnv.hazeScale },
      fogTurbulence: { value: SceneEnv.hazeDriftRate },
      time: { value: 0.0 },
      // Scattering per metre at full haze.
      hazeScatter: { value: HAZE_SCATTER_AT_FULL },
      hazeExtinction: { value: HAZE_EXTINCTION_AT_FULL },
      // Drawing the halo's source rather than the beam: see beam_halo.js.
      haloSource: { value: false },
      // The debug panel's multiplier, 1 by default.
      beamGain: { value: 1 },
      // Where the light starts, so a fragment knows which way its beam runs.
      beamOrigin: { value: new THREE.Vector3() },
      // The viewport, so a dot's beam can be held to a minimum width in pixels.
      resolution: { value: new THREE.Vector2(1, 1) },
      beamWidth: { value: BEAM_WIDTH_PIXELS },
      // The beam itself, in metres and radians.
      beamDiameter: { value: 0.003 },
      divergence: { value: 0.001 },
      beamLength: { value: BEAM_LENGTH },
      // This laser's depth tile: the atlas, where its tile sits, and the
      // world-to-clip matrix of its aperture camera. `depthReady` gates it, so
      // a beam with no tile yet is simply not truncated rather than vanishing.
      depthAtlas: { value: null },
      depthMatrix: { value: new THREE.Matrix4() },
      depthTile: { value: new THREE.Vector4(0, 0, 1, 1) },
      depthReady: { value: false },
      depthView: { value: new THREE.Matrix4() },
      depthFar: { value: 120 },
      // Metres: the compare is linear, not window-depth thousandths.
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
      uniform float beamDiameter;
      uniform float divergence;
      uniform float beamLength;
      varying vec3 vColor;
      varying vec3 vWorld;
      varying float vDot;
      varying float vPerPixel;
      varying float vWidthW;
      varying float vClipW;
      varying float vAcrossW;
      void main() {
        vColor = acolor;
        // A sheet's vertices carry no side; a dot's ribbon is +-1 across.
        vDot = abs(aSide);
        // The true world position, for the haze and depth reads: the pixel
        // offset below is far too small to matter to either.
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        mat4 mvp = projectionMatrix * viewMatrix * modelMatrix;
        vec4 here = mvp * vec4(position, 1.0);
        vec4 there = mvp * vec4(aOther, 1.0);
        // Metres per pixel at unit view depth; times the depth in perspective.
        vPerPixel = 2.0 / (projectionMatrix[1][1] * resolution.y);
        // Billboard the ribbon: expand this endpoint sideways from the beam's
        // screen direction, to the beam's own width at this end or the minimum
        // in pixels, whichever is wider. A diverging beam's edges are straight
        // lines, so the two ends place them.
        vec2 sHere = (here.xy / here.w) * resolution;
        vec2 sThere = (there.xy / there.w) * resolution;
        vec2 dir = sHere - sThere;
        float len = max(length(dir), 1e-4);
        vec2 perp = vec2(-dir.y, dir.x) / len;
        float metresPerPixel = vPerPixel * (isOrthographic ? 1.0 : here.w);
        float diameter = beamDiameter + divergence * adist * beamLength;
        float halfPx = max(beamWidth, diameter / metresPerPixel) * 0.5;
        // The drawn width in pixels, for the fragment to spread the light over
        // exactly what is drawn. Carried times w and divided by w there, so it
        // interpolates linearly across the screen as the ribbon's edges do.
        vWidthW = 2.0 * halfPx * here.w;
        vClipW = here.w;
        // A dot's ribbon is drawn a pixel wider each side and the fragment
        // weighs each pixel by its coverage, so every pixel column along the
        // beam gets the same light wherever the line crosses the pixel grid.
        float drawnPx = halfPx + vDot;
        vAcrossW = aSide * drawnPx * here.w;
        vec2 offsetPx = perp * aSide * drawnPx;
        here.xy += (offsetPx / resolution) * 2.0 * here.w;
        gl_Position = here;
      }
    `,
    fragmentShader: `${hazeShaderPrelude()}
      #include <packing>
      varying vec3 vColor;
      varying vec3 vWorld;
      varying float vDot;
      varying float vPerPixel;
      varying float vWidthW;
      varying float vClipW;
      varying float vAcrossW;
      uniform bool fogState;
      uniform float fogFactor;
      uniform float fogScale;
      uniform float fogTurbulence;
      uniform float time;
      uniform float hazeScatter;
      uniform float hazeExtinction;
      uniform bool haloSource;
      uniform float beamGain;
      uniform vec3 beamOrigin;
      uniform float beamWidth;
      uniform float beamDiameter;
      uniform float divergence;
      uniform sampler2D depthAtlas;
      uniform mat4 depthMatrix;
      uniform vec4 depthTile;
      uniform bool depthReady;
      uniform mat4 depthView;
      uniform float depthFar;
      uniform float depthBias;
      void main() {
        // No haze, nothing scatters: the beam is invisible in clean air.
        float haze = fogState ? clamp(fogFactor, 0.0, 1.0) : 0.0;
        if (haze <= 0.0) discard;
        // Stop at the first surface. The fragment's world position, projected
        // into the aperture camera, gives its place and depth in that view; the
        // atlas holds the nearest surface's depth along the same ray. Past it,
        // the light never arrived.
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
              if (here > surface + depthBias) discard;
            }
          }
        }
        vec3 fromAperture = vWorld - beamOrigin;
        float s = max(length(fromAperture), 0.05);
        vec3 travel = fromAperture / s;
        vec3 toCamera = cameraPosition - vWorld;
        vec3 toEye = isOrthographic
          ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
          : normalize(toCamera);
        float eyeDistance = isOrthographic ? 0.0 : length(toCamera);
        float cosTheta = dot(travel, toEye);

        float sigma = hazeScatter * haze;
        // The haze's loss on the way out and on the way to the eye, as the
        // mover beams pay it.
        float transmission = exp(-hazeExtinction * haze * (s + eyeDistance));
        float field = mix(1.0,
          fogging(vWorld / max(fogScale, 0.01), time * fogTurbulence), HAZE_FIELD_DEPTH);

        // Metres the light is spread across, as the view ray meets it.
        float across;
        float coverage = 1.0;
        if (vDot > 0.5) {
          // The beam's width convolved with a pixel: summed over the pixels
          // across, it comes to the drawn width whatever the sub-pixel offset.
          float halfWidthPx = 0.5 * vWidthW / max(vClipW, 1e-6);
          float fromCentrePx = abs(vAcrossW / max(vClipW, 1e-6));
          coverage = clamp(halfWidthPx + 0.5 - fromCentrePx, 0.0, 1.0);
          if (coverage <= 0.0) discard;
          float viewDepth = isOrthographic ? 1.0 : -(viewMatrix * vec4(vWorld, 1.0)).z;
          // The width drawn here: the beam's own, or one pixel where it is
          // narrower. The light is spread over what is drawn and no wider.
          float width = (vWidthW / max(vClipW, 1e-6)) * vPerPixel * viewDepth;
          float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
          across = width * max(sinTheta, 0.01);
        } else {
          vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          across = s * max(abs(dot(normal, toEye)), 0.02);
        }

        // The halo's source is the light scattered out and scattered again
        // towards the eye, so it takes the pair's phase; its alpha carries
        // luminance times distance, which the halo sizes its spread by.
        float phase = haloSource ? haloPhase(cosTheta) : hazeLobes(cosTheta);
        vec3 nits = vColor * sigma * phase * field * transmission * coverage / across;
        vec3 scene = nits * SCENE_PER_NIT * beamGain;
        float distance = isOrthographic ? 1.0 : length(toCamera);
        gl_FragColor = haloSource
          ? vec4(scene, dot(scene, vec3(0.2126, 0.7152, 0.0722)) * distance)
          : vec4(scene, 1.0);
      }
    `,
  });
}

class Laser {
  /**
   * @param {Object} data
   * @param {Object} data.params laser parameters, see `generic/laser.js`
   * @param {Function} [data.settingsAt] () => the placement's LaserSettings
   * @param {Object} [data.body] `{ geometry }`, a model drawn in place of the
   *   box, in the fixture's frame and size; shared, so never disposed here
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

    this._model = data.body && data.body.geometry ? data.body.geometry : null;
    this._body = new THREE.Mesh(this._model || BOX_GEOMETRY, BODY.material(this._params.bodyColor));
    this._body.userData.pickOwner = this;
    this._dummy.add(this._body);
    castsContactShadow(this._body);

    this._aperture = new THREE.Mesh(APERTURE_GEOMETRY, APERTURE_MATERIAL);
    this._aperture.userData.pickOwner = this;
    this._dummy.add(this._aperture);

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
    const aperture = apertureSize(params);

    // Width across, depth front-to-back, height up -- the box stands the way
    // the machine does. A model is drawn at its own size, and its aperture is
    // part of it.
    if (this._model) this._body.scale.set(1, 1, 1);
    else this._body.scale.set(width, depth, height);
    this._aperture.visible = !this._model;

    // The model measures the aperture from the centre of the front panel, seen
    // by someone facing it; same unnegated -Y/+Z convention as the projector's
    // lens. Set a hair proud of the panel so it is not co-planar with it.
    const ap = apertureOrigin(params);
    this._aperture.scale.set(aperture.width, 1, aperture.height);
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
   * @returns {Object|null} `{ protocol, service, address }`, and `via` the
   *   laser whose input it is when this one is fed Thru
   */
  resolveSource(settings) {
    // A test pattern overrides whatever the laser is fed, as a projector's
    // service test does; then the Mode channel; then the Protocol.
    const test = settings ? settings.testPattern : null;
    if (test) {
      return {
        protocol: 'clips', clip: test, test: true, service: null, address: null,
      };
    }
    const mode = (settings && settings.value('mode')) || 'input';
    if (mode === 'off') return null;
    // The standalone list: nothing to receive.
    if (mode === 'standalone') {
      return {
        protocol: 'clips', clip: settings ? settings.currentClip : null, service: null, address: null,
      };
    }
    return this.resolveFeed(settings, new Set([this]));
  }

  /**
   * What this laser's input carries, by its Protocol alone: no test pattern
   * and no Mode channel, which belong to the laser and not to its input.
   *
   * Thru takes the input of the laser `source` names, as an ILDA cable from
   * that laser's thru port would; a chain is followed, and a loop draws
   * nothing.
   *
   * @param {Object} settings this laser's LaserSettings, or null
   * @param {Set} seen the lasers already passed through on the way here
   * @returns {Object|null}
   */
  resolveFeed(settings, seen) {
    const protocol = (settings && settings.value('protocol')) || 'ponk';
    const address = (settings && settings.value('address')) || this._address || null;
    if (protocol === THRU_PROTOCOL) {
      const upstream = Laser.thruSourceOf(settings);
      if (!upstream || seen.has(upstream) || upstream._hidden) return null;
      seen.add(upstream);
      const fed = upstream.resolveFeed(upstream._settingsAt(), seen);
      return fed ? { ...fed, via: fed.via || upstream } : null;
    }
    if (protocol === 'clips') {
      return {
        protocol: 'clips', clip: settings ? settings.currentClip : null, service: null, address: null,
      };
    }
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
   * **Each point carries its share of the laser's light.** The laser puts out
   * its lumens all the time; a point gets the fraction of the frame the scanner
   * spends on it -- one over the points in a DAC's window, or its path's share
   * of the scan budget for Ponk -- times its colour and the output stage. A
   * line spreads that thin, a held dot (one point many times) concentrates it.
   *
   * Each consecutive pair of lit points is a sheet triangle from the aperture
   * out to the two rays' far ends, carrying the first point's flux per radian
   * of sweep. A point no sheet takes is a dot, drawn as a ribbon carrying its
   * flux. Blanked travel draws nothing.
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
    const { h, v: v0 } = scanHalfAngles(params);
    const { tanH, tanV } = fieldTangents(params);
    const divergence = Math.max(Number(params.divergence) || 0, 0) / 1000;
    const u = this._beamMaterial.uniforms;
    u.beamDiameter.value = Math.max(Number(params.beamDiameter) || 0, 0) / 1000;
    u.divergence.value = divergence;
    // A stroke on a surface is the beam's divergence wide, in tile units at the
    // axis, and never under the atlas's minimum.
    const minWidth = FIGURE_MIN_PIXELS * FIGURE_PIXEL;
    const figureWidth = Math.max(divergence / Math.min(tanH, tanV), minWidth);
    // A Ponk frame is paths, laid out as a DAC run with a blank between paths
    // and a share of the frame per point; a DAC's is the persistence window of
    // what it played. From here down the two are the same points.
    let frame = null;
    let shares = null;
    // Whether the frame marks its own travel: a Ponk path is one stroke, and an
    // ILDA frame blanks every jump, so any two lit points in a row are a line
    // the scanner drew. A DAC stream's travel is guessed from the distance.
    let explicitBlanking = false;
    if (source && source.protocol === 'clips') {
      // A clip taken Thru plays on the clock of the laser playing it.
      const clock = (source.via || this)._clipTime || 0;
      frame = clipFrame(source.clip, clock, Number(params.maxPointRate) || 0);
      explicitBlanking = true;
    } else if (source && source.protocol === 'ponk') {
      const ponk = LaserStream.ponkFrame(source.service);
      if (ponk) {
        frame = flattenPaths(ponk.paths, {
          pointRate: Number(params.maxPointRate) || 0,
          dwell: dwellModelValue,
          maxPoints: MAX_POINTS,
        });
        ({ shares } = frame);
        explicitBlanking = true;
      }
    } else if (source) {
      frame = LaserStream.frame(source.protocol, 50, source.service, source.address);
    }
    const n = Math.min(frame ? frame.count : 0, MAX_POINTS);
    const figure = {
      n: 0,
      far: ptFar,
      flux: ptFlux,
      lit: ptLit,
      linked: ptLinked,
      joined: ptJoined,
      clip: scratchClip,
      tanH,
      tanV,
      width: figureWidth,
    };
    if (n < 1) {
      this._beamGeo.setDrawRange(0, 0);
      this._figure.build(figure);
      return;
    }

    const pts = frame.points;
    const ap = apertureOrigin(params);
    const val = (key, fallback) => (settings ? Number(settings.value(key)) : fallback);
    const gain = settings ? settings.gain : 1;
    const red = (val('red', 100) / 100) * gain;
    const green = (val('green', 100) / 100) * gain;
    const blue = (val('blue', 100) / 100) * gain;
    // Lumens at full, as scene colour: each primary at the luminance its
    // flux gives, times how much brighter the line looks than the primary it
    // is drawn with (see `laser_appearance.js`).
    // Held back by the colour balance, so equal values draw white.
    const lumens = laserChannelLumens(params);
    const k = (c) => (lumens[c].lumens / PRIMARY_LUMINANCE[c]) * laserAppearance(c, lumens[c].nm);
    const drawn = { red: k('red'), green: k('green'), blue: k('blue') };
    const balance = whiteBalance(drawn);
    const kRed = drawn.red * balance.red;
    const kGreen = drawn.green * balance.green;
    const kBlue = drawn.blue * balance.blue;
    const evenShare = 1 / Math.max(frame.count, 1);
    // The figure is placed twice: the cue in the zone, then the zone in the
    // scan field. Each turns, sizes and moves; a turn is clockwise as the
    // audience sees it, ILDA's x being to the right and y up.
    const radians = (degrees) => ((Number(degrees) || 0) * Math.PI) / 180;
    const cueTurn = radians(val('rotation', 0) + (this._spinAngle || 0));
    const zoneTurn = radians(val('zoneRotation', 0));
    const cueCos = Math.cos(cueTurn);
    const cueSin = Math.sin(cueTurn);
    const zoneCos = Math.cos(zoneTurn);
    const zoneSin = Math.sin(zoneTurn);
    const zoom = val('zoom', 100) / 100;
    const cueX = (val('xScale', 100) / 100) * zoom;
    const cueY = (val('yScale', 100) / 100) * zoom;
    const zoneX = val('xSizeLimit', 100) / 100;
    const zoneY = val('ySizeLimit', 100) / 100;
    const cuePosX = val('cueX', 0) / 100;
    const cuePosY = val('cueY', 0) / 100;
    const xPos = val('xPos', 0) / 100;
    const yPos = val('yPos', 0) / 100;
    // Each position moves within the room its size leaves: an 80 % figure can
    // travel over the remaining 20 %, and never off the field. A negative size
    // turns the figure over; the room is the same either way.
    const roomX = 1 - Math.abs(cueX * zoneX);
    const roomY = 1 - Math.abs(cueY * zoneY);
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

    const putR = (x, y, z, ox, oy, oz, r, g, b, d, sd) => {
      if (v >= capacity) return;
      const p3 = v * 3;
      pos[p3] = x; pos[p3 + 1] = y; pos[p3 + 2] = z;
      other[p3] = ox; other[p3 + 1] = oy; other[p3 + 2] = oz;
      colour[p3] = r; colour[p3 + 1] = g; colour[p3 + 2] = b;
      dist[v] = d; side[v] = sd;
      v += 1;
    };
    // Sheet vertices carry no billboard: `aSide` 0 leaves the offset at zero.
    const putS = (x, y, z, r, g, b, d) => putR(x, y, z, x, y, z, r, g, b, d, 0);

    // Every point resolved once: is it lit, where does its ray end, its flux.
    for (let i = 0; i < n; i += 1) {
      const b = i * POINT_STRIDE;
      const lr = (pts[b + 2] / 65535) * red;
      const lg = (pts[b + 3] / 65535) * green;
      const lb = (pts[b + 4] / 65535) * blue;
      const share = shares ? shares[i] : evenShare;
      // Signed galvo positions carried as their 16-bit bit pattern, to -1..1.
      const rawX = ((pts[b] << 16) >> 16) / 32768;
      const rawY = ((pts[b + 1] << 16) >> 16) / 32768;
      // Position moves within the headroom the scale leaves: an 80% pattern
      // can travel over the remaining 20%, and never off the field.
      const fx = mirrorX ? -rawX : rawX;
      const fy = mirrorY ? -rawY : rawY;
      const cx = (fx * cueCos + fy * cueSin) * cueX + cuePosX * (1 - Math.abs(cueX));
      const cy = (fy * cueCos - fx * cueSin) * cueY + cuePosY * (1 - Math.abs(cueY));
      const zx = (cx * zoneCos + cy * zoneSin) * zoneX;
      const zy = (cy * zoneCos - cx * zoneSin) * zoneY;
      const nx = Math.min(Math.max(zx + xPos * roomX, -1), 1);
      const ny = Math.min(Math.max(zy + yPos * roomY, -1), 1);
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
      ptFar[i3] = ap.x - Math.sin(ax) * cosAy * BEAM_LENGTH;
      ptFar[i3 + 1] = ap.y - cosAx * cosAy * BEAM_LENGTH;
      ptFar[i3 + 2] = ap.z + cosAx * Math.sin(ay) * BEAM_LENGTH;
      ptFlux[i3] = lr * kRed * share;
      ptFlux[i3 + 1] = lg * kGreen * share;
      ptFlux[i3 + 2] = lb * kBlue * share;
      ptNorm[i * 2] = nx; ptNorm[i * 2 + 1] = ny;
      ptLit[i] = lr + lg + lb > LIT_EPSILON ? 1 : 0;
      ptLinked[i] = 0;
      ptJoined[i] = 0;
    }

    // The stroke itself: the surface a moving beam sweeps between one point and
    // the next. A straight line drawn by the scanner is one continuous sheet,
    // not a row of separate blades. Two rays from a single aperture span a
    // triangle, so each consecutive pair contributes one and a run of points
    // becomes a fan.
    for (let i = 0; i + 1 < n; i += 1) {
      const dx = ptNorm[(i + 1) * 2] - ptNorm[i * 2];
      const dy = ptNorm[(i + 1) * 2 + 1] - ptNorm[i * 2 + 1];
      // Blanked travel between figures must not be bridged, and a repeated
      // point spans no area: a held dot is the same point many times, and
      // left linked it would never get the ribbon below. See `explicitBlanking`.
      const step = dx * dx + dy * dy;
      const joined = step > 0 && (explicitBlanking || step <= JUMP_LIMIT * JUMP_LIMIT);
      if (ptLit[i] && ptLit[i + 1] && joined) {
        ptLinked[i] = 1;
        ptLinked[i + 1] = 1;
        ptJoined[i] = 1;
        const a3 = i * 3;
        const b3 = (i + 1) * 3;
        // The angle swept between the two rays: the chord of their unit
        // directions, as an angle.
        const cx = (ptFar[b3] - ptFar[a3]) / BEAM_LENGTH;
        const cy = (ptFar[b3 + 1] - ptFar[a3 + 1]) / BEAM_LENGTH;
        const cz = (ptFar[b3 + 2] - ptFar[a3 + 2]) / BEAM_LENGTH;
        const swept = 2 * Math.asin(Math.min(Math.sqrt(cx * cx + cy * cy + cz * cz) / 2, 1));
        const perRadian = 1 / Math.max(swept, 1e-6);
        const r = ptFlux[a3] * perRadian;
        const g = ptFlux[a3 + 1] * perRadian;
        const b = ptFlux[a3 + 2] * perRadian;
        putS(ap.x, ap.y, ap.z, r, g, b, 0);
        putS(ptFar[a3], ptFar[a3 + 1], ptFar[a3 + 2], r, g, b, 1);
        putS(ptFar[b3], ptFar[b3 + 1], ptFar[b3 + 2], r, g, b, 1);
      }
    }

    // What the sheet cannot show: a held dot, or a hot point standing alone
    // between blanked travel. Each is a beam of its own, its flux on a ribbon.
    for (let i = 0; i < n; i += 1) {
      if (ptLit[i] && !ptLinked[i]) {
        const i3 = i * 3;
        const fx = ptFar[i3];
        const fy = ptFar[i3 + 1];
        const fz = ptFar[i3 + 2];
        const r = ptFlux[i3];
        const g = ptFlux[i3 + 1];
        const b = ptFlux[i3 + 2];
        putR(ap.x, ap.y, ap.z, fx, fy, fz, r, g, b, 0, -1);
        putR(ap.x, ap.y, ap.z, fx, fy, fz, r, g, b, 0, 1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, r, g, b, 1, 1);
        putR(ap.x, ap.y, ap.z, fx, fy, fz, r, g, b, 0, -1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, r, g, b, 1, 1);
        putR(fx, fy, fz, ap.x, ap.y, ap.z, r, g, b, 1, -1);
      }
    }

    this._beamGeo.setDrawRange(0, v);

    // The picture, from the same points, the same lit test and the same jump
    // guard the sheet above was built from -- so the figure on the wall and the
    // beams in the air are the same figure, not two that have to be kept in step.
    u.beamOrigin.value.setFromMatrixPosition(this._depthCam.matrixWorld);
    scratchClip.copy(this._depthMatrix).multiply(this._dummy.matrixWorld);
    figure.n = n;
    figure.gain = figureGainValue;
    this._figure.build(figure);
    this._beamGeo.attributes.position.needsUpdate = true;
    this._beamGeo.attributes.aOther.needsUpdate = true;
    this._beamGeo.attributes.acolor.needsUpdate = true;
    this._beamGeo.attributes.adist.needsUpdate = true;
    this._beamGeo.attributes.aSide.needsUpdate = true;
  }

  /**
   * How wide one depth texel is, in metres per metre of distance along the
   * axis: the wider half of the scan field's tangent across half a tile. A
   * perspective tile is even in the tangent, so this holds across all of it.
   *
   * @public
   * @returns {Number}
   */
  depthTexelTan() {
    const { tanH, tanV } = fieldTangents(this._params || {});
    return (2 * Math.max(tanH, tanV)) / LASER_DEPTH.tile;
  }

  /**
   * Aims the aperture depth camera and rebuilds its world-to-clip matrix.
   *
   * A perspective camera at the aperture, looking down the throw with the fixed
   * basis, its frustum covering the scan up to `FIELD_HALF_MAX` either side:
   * vertical fov is the scan height and the aspect the ratio of the two
   * half-angle tangents, so an asymmetric scanner still maps square. Matrices
   * are set by hand and the automatic pass is off, for the same reason the
   * projector's are -- three would otherwise rebuild them from an untouched
   * position.
   *
   * @public
   */
  updateDepthCamera() {
    const params = this._params || {};
    const ap = apertureOrigin(params);
    const { tanH, tanV } = fieldTangents(params);
    this._dummy.updateMatrixWorld();
    this._depthCam.matrixWorld
      .makeTranslation(ap.x, ap.y, ap.z)
      .multiply(this._basis)
      .premultiply(this._dummy.matrixWorld);
    this._depthCam.matrixWorldInverse.copy(this._depthCam.matrixWorld).invert();
    this._depthCam.fov = Math.max(1, 2 * Math.atan(tanV) * (180 / Math.PI));
    this._depthCam.aspect = Math.max(tanH, 1e-3) / Math.max(tanV, 1e-3);
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
    // A model is drawn about its file's origin, which need not be its centre.
    if (this._model) {
      if (!this._model.boundingBox) this._model.computeBoundingBox();
      bodyBounds.copy(this._model.boundingBox);
    } else {
      bodyBounds.min.set(-width / 2, -depth / 2, -height / 2);
      bodyBounds.max.set(width / 2, depth / 2, height / 2);
    }
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
   * since local +Z is up, or a model's lowest point below its origin.
   *
   * @readonly
   * @type {Number}
   */
  get floorOffset() {
    if (this._model) {
      if (!this._model.boundingBox) this._model.computeBoundingBox();
      return -this._model.boundingBox.min.z;
    }
    return (Number((this._params || {}).height) || 0) / 2;
  }

  /**
   * Shows or hides the outline and the aim line together.
   *
   * @public
   * @param {Boolean} state
   */
  showAids(state) {
    setOutlined(this, !!state, this.outlineMeshes());
    this._aim.visible = !!state;
  }

  /**
   * What the selection outline is drawn round: its body and aperture.
   *
   * @public
   * @returns {Array<THREE.Mesh>}
   */
  outlineMeshes() {
    return [this._body, this._aperture];
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
   * Whether the fixture is hidden from the scene. A hidden laser does nothing:
   * it is not drawn, builds no beam or figure, holds no depth or figure tile,
   * puts nothing in the beams' halo and offers no input on the network.
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
    setOutlined(instance, false);
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
  static update(t, renderer) {
    if (!LaserStream.enabled) LaserStream.enable();
    Laser.publishInputs();
    // The viewport, so a dot's beam keeps its minimum width in pixels.
    if (renderer) renderer.getSize(scratchResolution);
    instances.forEach((laser) => {
      if (laser._hidden) {
        laser._beamGeo.setDrawRange(0, 0);
        return;
      }
      const u = laser._beamMaterial.uniforms;
      u.time.value = t || 0;
      // A clip's clock runs at the scan rate times the speed, so a change
      // slows or quickens it from where it is.
      const now = t || 0;
      const settings = laser._settingsAt();
      const clock = settings && settings.clipClock !== undefined ? settings.clipClock : 1;
      const step = laser._clockAt === undefined ? 0 : Math.max(now - laser._clockAt, 0);
      laser._clockAt = now;
      laser._clipTime = (laser._clipTime || 0) + step * clock;
      // The spin turns from wherever it is, so a change of speed never jumps.
      const spin = settings && settings.spinRate !== undefined ? settings.spinRate : 0;
      laser._spinAngle = settings && settings.spinResets
        ? 0 : ((laser._spinAngle || 0) + step * spin) % 360;
      // Level with the room every frame, the way the mover beam is kept level,
      // so a laser is never drawn through haze the room does not have.
      u.fogState.value = SceneEnv.hazeEnabled;
      u.fogFactor.value = SceneEnv.hazeAmount;
      u.fogScale.value = SceneEnv.hazeScale;
      u.fogTurbulence.value = SceneEnv.hazeDriftRate;
      u.beamGain.value = beamGainValue;
      if (renderer) u.resolution.value.copy(scratchResolution);
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
   * @returns {Array} each `{ matrix, depthTile, figureTile, position,
   *   texelTan }`, the last how wide one depth texel is per metre of distance
   */
  static projections() {
    const out = [];
    instances.forEach((laser) => {
      if (laser._hidden) return;
      if (laser._depthSlot < 0 || laser._figureSlot < 0) return;
      out.push({
        matrix: laser._depthMatrix,
        depthTile: LASER_DEPTH.tileUv(laser._depthSlot),
        figureTile: FIGURE_ATLAS.tileUv(laser._figureSlot),
        position: laser._aperturePos.setFromMatrixPosition(laser._depthCam.matrixWorld),
        texelTan: laser.depthTexelTan(),
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
    // Service numbers are per IDN unit. Those set by hand are taken first; a
    // laser without one gets the lowest number still free on its unit, which
    // is 1, 2, 3 in show order when none is set. Lasers sharing a number draw
    // the same stream.
    const unitOf = (address) => `idn@${address || 'default'}`;
    const used = new Map();
    const usedOn = (unit) => {
      if (!used.has(unit)) used.set(unit, new Set());
      return used.get(unit);
    };
    [...instances].forEach((laser) => {
      const settings = laser._settingsAt();
      if (laser._hidden || !settings || settings.value('protocol') !== 'idn') return;
      const set = Number(settings.value('service')) || 0;
      if (set) usedOn(unitOf(settings.value('address') || null)).add(set);
    });
    [...instances].forEach((laser, i) => {
      const handle = laser.fixtureHandle;
      const settings = laser._settingsAt();
      const protocol = (settings && settings.value('protocol')) || 'ponk';
      // A hidden laser offers no input; a clip list plays here, and Thru
      // takes another laser's, with no device for the main process to run.
      if (laser._hidden || protocol === 'clips' || protocol === THRU_PROTOCOL) return;
      const address = (settings && settings.value('address')) || null;
      const name = (handle && handle.name) || `Laser ${i + 1}`;
      let service = null;
      if (protocol === 'idn') {
        const taken = usedOn(unitOf(address));
        let id = Number(settings.value('service')) || 0;
        if (!id) {
          id = 1;
          while (taken.has(id)) id += 1;
          taken.add(id);
        }
        service = taken.size > MAX_SERVICES || id > 255 ? -1 : id;
      }
      laser._serviceId = service === null ? 1 : service;
      // Written only when the asked-for address changes. The hub answers with
      // the address the device is really bound to and tags batches with it,
      // so overwriting it every frame would leave a laser on the default
      // address looking up its stream under the wrong key.
      if (laser._addressAsked !== address) {
        laser._addressAsked = address;
        laser._address = address;
      }
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
  /**
   * What one laser's input is really doing.
   *
   * Answered here rather than worked out again in the widget, and from
   * `resolveSource` -- the same resolution the beam is drawn from. Matching a
   * report row on protocol alone would make every laser on a protocol claim
   * the first live stream on it, so two lasers would both say they were
   * receiving while one of them drew nothing.
   *
   * @static
   * @param {Object} fixture
   * @returns {Object|null} `{ protocol, address, service, live, rate, points,
   *   name, error }`, or null when this fixture has no laser
   */
  static inputStateFor(fixture) {
    const laser = Laser.instanceFor(fixture);
    if (!laser) return null;
    const settings = laser._settingsAt();
    const source = laser.resolveSource(settings);
    const error = laser.inputError();
    // Thru: the laser whose input this is, by name.
    const via = source && source.via
      ? (source.via.fixtureHandle && source.via.fixtureHandle.name) || 'another laser' : null;
    const fed = (settings && settings.value('protocol')) || 'ponk';
    const mode = (settings && settings.value('mode')) || 'input';
    if (!source) {
      return {
        protocol: fed,
        mode,
        address: (settings && settings.value('address')) || null,
        service: null,
        live: false,
        rate: 0,
        points: 0,
        name: null,
        error,
        via,
      };
    }
    if (source.protocol === 'clips') {
      const { clip } = source;
      const status = clipStatus(clip);
      const params = laser._params || {};
      const clock = (source.via || laser)._clipTime || 0;
      const frame = clipFrame(clip, clock, Number(params.maxPointRate) || 0);
      return {
        protocol: 'clips',
        address: null,
        service: null,
        live: status.state === 'ready',
        rate: clip ? (clip.rate || Number(params.maxPointRate) || 0)
          * (settings && settings.scanShare !== undefined ? settings.scanShare : 1) : 0,
        points: frame ? frame.count : 0,
        frames: status.frames,
        name: clip ? clip.name : null,
        clipState: status.state,
        // A test pattern, or the Mode channel, playing over the Protocol.
        test: !!source.test,
        fed,
        mode,
        error: status.error || error,
        via,
      };
    }
    if (source.protocol === 'ponk') {
      const frame = LaserStream.ponkFrame(source.service);
      const points = frame
        ? frame.paths.reduce((n, path) => n + (path.count || 0), 0) : 0;
      return {
        protocol: 'ponk',
        address: null,
        service: source.service,
        live: !!frame,
        rate: 0,
        points,
        name: frame ? frame.name : null,
        error,
        via,
      };
    }
    // A DAC stream is its own device: protocol, address and -- for IDN -- the
    // service this laser was given on that unit. All three, or a laser reads
    // another one's stream as its own.
    const row = LaserStream.report().find((r) => r.protocol === source.protocol
      && (r.address || null) === (source.address || null)
      && (r.service === undefined ? null : r.service) === source.service);
    return {
      protocol: source.protocol,
      address: source.address,
      service: source.service,
      live: !!(row && row.live),
      rate: row ? row.rate : 0,
      points: row ? row.held : 0,
      name: null,
      error,
      via,
    };
  }

  /**
   * The renderer instance a fixture handle belongs to.
   *
   * @static
   * @param {Object} fixture
   * @returns {Object|null}
   */
  /**
   * Draws every laser's beam into the halo's source, as the mover beams are:
   * plain sums with alpha carrying luminance times distance, at the target's
   * own resolution so a beam is at least one of its pixels wide with its
   * light conserved. See beam_halo.js.
   *
   * @public
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera the view
   * @param {THREE.WebGLRenderTarget} target where it goes
   * @param {Boolean} clear whether to clear the target first
   * @returns {Boolean} whether any laser had a beam to draw
   */
  static renderHaloSource(renderer, camera, target, clear) {
    const lit = [...instances].filter((laser) => !laser._hidden && laser._beam
      && laser._beam.visible && laser._beamGeo.drawRange.count > 0);
    if (!lit.length) return false;
    const clearColor = renderer.getClearColor(haloClearColor);
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    if (clear) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
    }
    lit.forEach((laser) => {
      const material = laser._beamMaterial;
      const u = material.uniforms;
      const blending = [material.blending, material.blendSrc, material.blendDst,
        material.blendSrcAlpha, material.blendDstAlpha];
      material.blending = THREE.CustomBlending;
      material.blendSrc = THREE.OneFactor;
      material.blendDst = THREE.OneFactor;
      material.blendSrcAlpha = THREE.OneFactor;
      material.blendDstAlpha = THREE.OneFactor;
      u.haloSource.value = true;
      haloResolution.copy(u.resolution.value);
      u.resolution.value.set(target.width, target.height);
      renderer.render(laser._beam, camera);
      u.resolution.value.copy(haloResolution);
      u.haloSource.value = false;
      [material.blending, material.blendSrc, material.blendDst,
        material.blendSrcAlpha, material.blendDstAlpha] = blending;
    });
    renderer.setClearColor(clearColor, clearAlpha);
    return true;
  }

  /**
   * The IDN service number a laser is published under, set by hand or given.
   *
   * @static
   * @param {Object} fixture
   * @returns {Number|null}
   */
  static serviceFor(fixture) {
    const laser = Laser.instanceFor(fixture);
    return laser && laser._serviceId > 0 ? laser._serviceId : null;
  }

  /**
   * The laser a Thru laser takes its input from: the one its `source` names.
   *
   * @static
   * @param {Object} settings the Thru laser's LaserSettings
   * @returns {Object|null} that laser's renderer instance
   */
  static thruSourceOf(settings) {
    const value = settings ? settings.value('source') : null;
    if (typeof value !== 'string' || !value.startsWith(THRU_PREFIX)) return null;
    const uid = value.slice(THRU_PREFIX.length);
    return [...instances].find((l) => l.fixtureHandle && l.fixtureHandle.uid === uid) || null;
  }

  /**
   * The lasers another may take its input from: every one in the show but
   * itself, by name.
   *
   * @static
   * @param {Object} fixture the laser choosing
   * @returns {Array} each `{ value, label }`, value `laser:<uid>`
   */
  static thruChoices(fixture) {
    const self = Laser.instanceFor(fixture);
    return [...instances]
      .filter((l) => l !== self && l.fixtureHandle && l.fixtureHandle.uid)
      .map((l, i) => ({
        value: `${THRU_PREFIX}${l.fixtureHandle.uid}`,
        label: l.fixtureHandle.name || `Laser ${i + 1}`,
      }));
  }

  /**
   * The renderer instance a fixture handle belongs to.
   *
   * @static
   * @param {Object} fixture
   * @returns {Object|null}
   */
  static instanceFor(fixture) {
    if (!fixture) return null;
    return [...instances].find((l) => l.fixtureHandle === fixture
      || (l.fixtureHandle && fixture.uid && l.fixtureHandle.uid === fixture.uid)) || null;
  }

  static inputErrorFor(fixture) {
    const laser = Laser.instanceFor(fixture);
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
    instances.forEach((laser) => { if (laser._hidden) laser._figureSlot = -1; });
    const list = [...instances].filter((laser) => !laser._hidden);
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
    instances.forEach((laser) => {
      if (!laser._hidden) return;
      laser._depthSlot = -1;
      laser._beamMaterial.uniforms.depthReady.value = false;
    });
    const list = [...instances].filter((laser) => !laser._hidden);
    if (!list.length) return;
    if (!occlusionEnabled) {
      // Not just an early return: a tile bound last frame would go on cutting.
      list.forEach((laser) => { laser._beamMaterial.uniforms.depthReady.value = false; });
      return;
    }
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
    // -- body, aperture, aim, beam -- sets `castShadow`, so a chassis cannot
    // cut its own beam off at the muzzle. If a laser body is ever made to
    // cast, this is where the fixture has to stand down.
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
    if (depthDumpPending) {
      depthDumpPending = false;
      const casters = [];
      scene.traverse((object) => {
        if (!object.isMesh || !object.castShadow) return;
        const label = object.userData.sceneObjectModel || object.name || object.type;
        casters.push(`${label}${object.isInstancedMesh ? ` x${object.count}` : ''}${object.visible ? '' : ' hidden'}`);
      });
      console.log(`[laser depth] casters: ${casters.join(', ')}`);
      Laser.logDepthTiles(renderer, list);
    }
  }

  /**
   * Reads every laser's depth tile back and logs it: a coarse grid of metres,
   * and the whole tile as a PNG data URL. Diagnostic only -- a readback stalls
   * the GPU, so this runs once per press of the debug-panel button.
   *
   * @static
   * @param {Object} renderer
   * @param {Array} list the lasers, in slot order
   */
  static logDepthTiles(renderer, list) {
    const { target } = LASER_DEPTH;
    if (!target) return;
    const { tile, far } = LASER_DEPTH;
    const pixels = new Uint8Array(tile * tile * 4);
    // Undo `packDepthToRGBA`: three's `UnpackFactors4` on bytes, red the most
    // significant and alpha the least.
    const unpack = (i) => (
      (255 / 256) * (pixels[i] / 255 + pixels[i + 1] / 255 / 256 + pixels[i + 2] / 255 / 65536)
      + pixels[i + 3] / 255 / 16777216
    ) * far;
    list.forEach((laser) => {
      if (laser._depthSlot < 0) return;
      const column = laser._depthSlot % LASER_DEPTH.columns;
      const row = Math.floor(laser._depthSlot / LASER_DEPTH.columns);
      renderer.readRenderTargetPixels(target, column * tile, row * tile, tile, tile, pixels);
      const name = laser.fixtureHandle && laser.fixtureHandle.name ? laser.fixtureHandle.name : `laser ${laser._depthSlot}`;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < pixels.length; i += 4) {
        const d = unpack(i);
        if (d < min) min = d;
        if (d > max) max = d;
      }
      // Rows top to bottom, like the ray-cast tables this is compared with.
      const lines = [];
      for (let r = DEPTH_DUMP_GRID - 1; r >= 0; r -= 1) {
        const y = Math.floor(((r + 0.5) / DEPTH_DUMP_GRID) * tile);
        const cells = [];
        for (let c = 0; c < DEPTH_DUMP_GRID; c += 1) {
          const x = Math.floor(((c + 0.5) / DEPTH_DUMP_GRID) * tile);
          cells.push(unpack((y * tile + x) * 4).toFixed(1).padStart(6));
        }
        lines.push(cells.join(''));
      }
      const eye = new THREE.Vector3().setFromMatrixPosition(laser._depthCam.matrixWorld);
      const aim = new THREE.Vector3(0, 0, -1).transformDirection(laser._depthCam.matrixWorld);
      const fmt = (v) => v.toArray().map((x) => x.toFixed(2)).join(' ');
      console.log(`[laser depth] ${name} slot ${laser._depthSlot} min ${min.toFixed(2)} m max ${max.toFixed(2)} m`
        + ` eye ${fmt(eye)} aim ${fmt(aim)} fov ${laser._depthCam.fov.toFixed(1)} aspect ${laser._depthCam.aspect.toFixed(2)}`
        + ` body ${fmt(laser._position)} rot ${fmt(laser._rotation)}\n${lines.join('\n')}`);
      // The picture: near is bright, 20 m and beyond is black, top row at top.
      const canvas = document.createElement('canvas');
      canvas.width = tile;
      canvas.height = tile;
      const context = canvas.getContext('2d');
      const image = context.createImageData(tile, tile);
      for (let y = 0; y < tile; y += 1) {
        for (let x = 0; x < tile; x += 1) {
          const d = unpack(((tile - 1 - y) * tile + x) * 4);
          const g = Math.round(255 * (1 - Math.min(d, 20) / 20));
          const o = (y * tile + x) * 4;
          image.data[o] = g;
          image.data[o + 1] = g;
          image.data[o + 2] = g;
          image.data[o + 3] = 255;
        }
      }
      context.putImageData(image, 0, 0);
      console.log(`[laser depth png] ${name} ${canvas.toDataURL('image/png')}`);
    });
  }

  /** @public @param {Boolean} on whether beams stop at the first surface */
  static setOcclusion(on) {
    occlusionEnabled = !!on;
  }

  /** @public @returns {Boolean} whether beams stop at the first surface */
  static occlusion() {
    return occlusionEnabled;
  }

  /** @public Logs every laser's depth tile on the next frame. */
  static dumpDepthTiles() {
    depthDumpPending = true;
  }

  /**
   * The figure's multiplier over its photometric brightness, for the debug
   * panel.
   *
   * @public
   * @param {Number} gain 0 to 10
   */
  static setSurfaceGain(gain) {
    figureGainValue = Math.min(Math.max(Number(gain) || 0, 0), GAIN_MAX);
  }

  /** @public @returns {Number} the figure's multiplier */
  static surfaceGain() {
    return figureGainValue;
  }

  /**
   * Retired controls the debug panel still lists. Width and reach come from
   * the fixture's optics and the haze; these change nothing and report the
   * fixed values.
   *
   * @public
   */
  /** @public */
  static setBeamLength() {}

  /** @public @returns {Number} how far a beam is drawn, in metres */
  static beamLength() {
    return BEAM_LENGTH;
  }

  /** @public */
  static setBeamTail() {}

  /** @public @returns {Number} */
  static beamTail() {
    return 0;
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

  /** @public Retired with the others above. */
  static setScatterAmount() {}

  /** @public @returns {Number} */
  static scatterAmount() {
    return 1;
  }

  /** @public @returns {Number} the beams' multiplier */
  static scatterGain() {
    return beamGainValue;
  }

  /** @public */
  static setFigureWidth() {}

  /** @public @returns {Number} the narrowest stroke on a surface, in atlas pixels */
  static figureWidth() {
    return FIGURE_MIN_PIXELS;
  }

  /**
   * The beams' multiplier over their photometric brightness, for the debug
   * panel.
   *
   * @public
   * @param {Number} gain 0 to 10
   */
  static setScatterGain(gain) {
    beamGainValue = Math.min(Math.max(Number(gain) || 0, 0), GAIN_MAX);
  }

  /** @public */
  static setHazeBase() {}

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
