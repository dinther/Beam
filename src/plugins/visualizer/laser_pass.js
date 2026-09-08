import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';

/**
 * @file Puts every laser's figure onto whatever the camera can see.
 *
 * The beam in the air is geometry, built in `laser.js` -- a fan of triangles
 * through the haze. This is the other half: where those beams land, the figure
 * has to appear *on* the stone. Two different questions, and they want two
 * different answers. A shaft through haze is a volume, best drawn as one; a
 * line painted across a facade is a picture, best projected.
 *
 * A full-screen pass rather than anything the scene's materials know about, for
 * the reasons `projector_pass` sets out at length and which apply unchanged
 * here: it scales with fixtures rather than with materials, overlapping lasers
 * add up and read as a hotspot the way real light does, and the frustum is ours
 * to define.
 *
 * **It reads two atlases, and they are not interchangeable.** The figure atlas
 * says *what* the laser is drawing at each point of its field; the depth atlas
 * says *how far away the first surface is* in that direction. The figure alone
 * would paint straight through the building onto whatever stood behind it --
 * light does not do that, and the depth test is what stops it. Both are tiled
 * the same way and read with the same frame coordinate, so one projection does
 * for both.
 *
 * The depth atlas here is the laser's own, which holds **linear metres over
 * far** rather than window depth -- so the comparison is a subtraction in
 * metres instead of undoing a perspective divide. See `projector_depth.js` for
 * why the laser's tiles are packed that way.
 */

/** As many lasers as the atlases have tiles. */
const SLOTS = 16;

/**
 * How far past the first surface a fragment may sit and still count as lit.
 *
 * In metres, because the laser atlas is linear. Generous enough to swallow the
 * quantisation of a 512 tile seen at a glancing angle, tight enough that the
 * figure does not bleed around a corner.
 */
const DEPTH_BIAS = 0.08;

/**
 * Watts to something the tone curve can eat.
 *
 * The one number here set by looking rather than derived. Everything else --
 * the inverse square, the cosine, the colour -- is computed. A laser's figure
 * is not an illuminance a designer quotes in lux the way a projector's picture
 * is, so there is no external anchor to calibrate against; this is tuned
 * against Paul's 7.5 W LaserCube on a facade and belongs on the debug panel.
 */
const SURFACE_GAIN = 12.0;

const FRAGMENT = /* glsl */`
  uniform mat4 projInverse;
  uniform mat4 camWorld;
  uniform vec3 camPos;
  uniform sampler2D figureAtlas;
  uniform sampler2D depthAtlas;
  uniform mat4 laserMatrix[SLOTS];
  uniform vec4 depthTile[SLOTS];
  uniform vec4 figureTile[SLOTS];
  uniform vec3 laserPos[SLOTS];
  uniform float power[SLOTS];
  uniform float laserFar;
  uniform int liveCount;
  uniform int hasAtlas;

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    // No surface, nothing to paint. Unlike the projector pass this has no shaft
    // to march: the beam in the air is real geometry, drawn before this runs, so
    // empty sky genuinely has nothing to add here.
    if (liveCount == 0 || hasAtlas == 0 || depth >= 1.0) {
      outputColor = vec4(0.0, 0.0, 0.0, inputColor.a);
      return;
    }

    // The world point this pixel is looking at, rebuilt from the depth buffer.
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = projInverse * clip;
    viewPos /= viewPos.w;
    vec3 world = (camWorld * viewPos).xyz;

    // The surface's facing, from how the reconstructed position moves across
    // the screen, turned to face the eye -- the cross product's sign follows
    // screen winding, not the surface's outside.
    vec3 surfaceNormal = normalize(cross(dFdx(world), dFdy(world)));
    if (dot(surfaceNormal, camPos - world) < 0.0) surfaceNormal = -surfaceNormal;

    vec3 total = vec3(0.0);
    for (int i = 0; i < SLOTS; i++) {
      if (i >= liveCount) break;

      // Masked rather than branched, for the reason the projector pass gives:
      // a texture read inside per-pixel control flow has undefined derivatives.
      vec4 lc = laserMatrix[i] * vec4(world, 1.0);
      float inFront = step(0.0001, lc.w);
      vec3 ndc = lc.xyz / max(lc.w, 0.0001);
      float widest = max(max(abs(ndc.x), abs(ndc.y)), abs(ndc.z));
      float inside = inFront * step(widest, 1.0);

      vec2 frame = clamp(ndc.xy * 0.5 + 0.5, 0.0, 1.0);

      // Can this laser actually see the point, or is the building in the way?
      // Both sides in metres: lc.w is distance along the throw, and the tile
      // holds distance over far.
      vec4 dt = depthTile[i];
      float seen = unpackRGBAToDepth(texture2D(depthAtlas, dt.xy + frame * dt.zw)) * laserFar;
      float visible = step(lc.w, seen + DEPTH_BIAS);

      // What it is drawing in that direction. The colour already carries the
      // dimmer, the shutter and the RGB balance -- it was written into the
      // figure from the same points the beams were built from.
      vec4 ft = figureTile[i];
      vec3 figure = texture2D(figureAtlas, ft.xy + frame * ft.zw).rgb;

      // An angular emitter spreads its field over the square of the distance,
      // the same as the projector's throw maths.
      float throwDistance = max(lc.w, 0.05);
      float falloff = 1.0 / (throwDistance * throwDistance);

      // Straight on is full value, edge on is nothing -- measured to the
      // aperture, which is what lights this surface.
      vec3 toLaser = normalize(laserPos[i] - world);
      float lambert = max(dot(surfaceNormal, toLaser), 0.0);

      total += figure * power[i] * falloff * lambert * inside * visible;
    }

    outputColor = vec4(total, inputColor.a);
  }
`;

/**
 * The pass that paints every laser's figure onto the scene.
 */
class LaserEffect extends Effect {
  /** @param {Object} camera the scene camera the frame was drawn with */
  constructor(camera) {
    const laserMatrix = [];
    const depthTile = [];
    const figureTile = [];
    const laserPos = [];
    const power = [];
    for (let i = 0; i < SLOTS; i += 1) {
      laserMatrix.push(new THREE.Matrix4());
      depthTile.push(new THREE.Vector4(0, 0, 1, 1));
      figureTile.push(new THREE.Vector4(0, 0, 1, 1));
      laserPos.push(new THREE.Vector3());
      power.push(0);
    }

    super('LaserEffect', FRAGMENT, {
      blendFunction: BlendFunction.ADD,
      // Without this the pass has no depth buffer, and there would be no
      // surface to put a figure on.
      attributes: EffectAttribute.DEPTH,
      defines: new Map([
        ['SLOTS', `${SLOTS}`],
        ['DEPTH_BIAS', DEPTH_BIAS.toFixed(4)],
      ]),
      uniforms: new Map([
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['camPos', new THREE.Uniform(new THREE.Vector3())],
        ['figureAtlas', new THREE.Uniform(null)],
        ['depthAtlas', new THREE.Uniform(null)],
        ['laserMatrix', new THREE.Uniform(laserMatrix)],
        ['depthTile', new THREE.Uniform(depthTile)],
        ['figureTile', new THREE.Uniform(figureTile)],
        ['laserPos', new THREE.Uniform(laserPos)],
        ['power', new THREE.Uniform(power)],
        ['laserFar', new THREE.Uniform(120)],
        ['liveCount', new THREE.Uniform(0)],
        ['hasAtlas', new THREE.Uniform(0)],
      ]),
    });

    this.camera = camera;
    this.lasers = [];
    this.figureTexture = null;
    this.depthTexture = null;
    this.far = 120;
  }

  /**
   * Hands the pass what to paint this frame.
   *
   * Pushed from the render loop rather than pulled from here, because the
   * lasers come from the fixture layer and the pass has no business reaching
   * into it.
   *
   * @public
   * @param {Array} lasers each `{ matrix, depthTile, figureTile, position, power }`
   * @param {Object} figureTexture the figure atlas
   * @param {Object} depthTexture the laser depth atlas
   * @param {Number} far the range the depth atlas was packed against
   */
  setLasers(lasers, figureTexture, depthTexture, far) {
    this.lasers = lasers || [];
    this.figureTexture = figureTexture || null;
    this.depthTexture = depthTexture || null;
    if (far) this.far = far;
  }

  /**
   * @public
   * @param {Object} renderer
   * @param {Object} inputBuffer
   * @param {Number} deltaTime
   */
  // eslint-disable-next-line no-unused-vars
  update(renderer, inputBuffer, deltaTime) {
    const { uniforms, camera } = this;
    if (camera) {
      uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
      uniforms.get('camWorld').value.copy(camera.matrixWorld);
      uniforms.get('camPos').value.setFromMatrixPosition(camera.matrixWorld);
    }

    const live = this.lasers.slice(0, SLOTS);
    uniforms.get('liveCount').value = live.length;
    uniforms.get('figureAtlas').value = this.figureTexture;
    uniforms.get('depthAtlas').value = this.depthTexture;
    uniforms.get('laserFar').value = this.far;
    uniforms.get('hasAtlas').value = this.figureTexture && this.depthTexture ? 1 : 0;

    const matrices = uniforms.get('laserMatrix').value;
    const depthTiles = uniforms.get('depthTile').value;
    const figureTiles = uniforms.get('figureTile').value;
    const positions = uniforms.get('laserPos').value;
    const powers = uniforms.get('power').value;

    live.forEach((laser, i) => {
      matrices[i].copy(laser.matrix);
      const dt = laser.depthTile;
      const ft = laser.figureTile;
      depthTiles[i].set(dt.x, dt.y, dt.width, dt.height);
      figureTiles[i].set(ft.x, ft.y, ft.width, ft.height);
      positions[i].copy(laser.position);
      powers[i] = laser.power * SURFACE_GAIN;
    });
  }
}

export default LaserEffect;
