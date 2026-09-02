import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import ProjectorDepth, {
  MAX_PROJECTIONS, PROJECTOR_NEAR, PROJECTOR_FAR,
} from './projector_depth';
import { hazeShaderPrelude, hazeUniforms } from './haze_noise';
import SceneEnv from './scene_env';

/**
 * @file Puts every projector's picture onto whatever the camera can see.
 *
 * A full-screen pass rather than a light, and rather than anything the scene's
 * materials know about. Three reasons, in the order they mattered:
 *
 *  - **It scales with projectors, not with materials.** Six machines on a
 *    facade cost one pass over the frame, whatever the building is made of.
 *    Patching materials would mean every mesh in the show carrying projector
 *    code it almost never uses.
 *  - **Overlap stays visible.** Two projectors covering the same stone add up
 *    and read as a hotspot, which is exactly the thing a coverage preview is
 *    for -- it is where you would blend. Anything that averaged or clamped
 *    would hide the problem being looked for.
 *  - **The frustum is ours.** Lens shift is an asymmetric frustum, and nothing
 *    in the renderer's light path can express one.
 *
 * The picture is sampled from the *same* decoded video texture every other
 * consumer reads, with the connector's rectangle as a uniform. There is no
 * render target per projector, because there is nothing to pre-render: a slice
 * of a frame is a coordinate transform, not a copy.
 *
 * **The shaft.** The same maths, walked along the view ray instead of stopping
 * at the surface: at each step, is this piece of air inside a projector's
 * frustum, and can the lens see it. So the beam in the air and the picture on
 * the wall cannot disagree -- an occluder that shadows the facade cuts the
 * shaft above it too. It reads `hazeAmount` rather than `roomHaze`, because a
 * projector lighting its own cone is a fixture, and a fixture's beam survives
 * the house coming up.
 */

/**
 * Linear scene units per lux. The one calibration constant, and a real one.
 *
 * Everything else about a projector's brightness is computed rather than
 * chosen. Illuminance is lumens over the area the lens makes at that distance,
 * which is a number a designer already thinks in -- a dark venue is one to five
 * lux, street lighting ten to twenty, a mapping rig on a facade fifty to a
 * hundred and fifty. Taking the area from the frustum means a zoom or a shift
 * is accounted for without being asked about: narrow the lens and the same
 * lumens land on less wall and it gets brighter, exactly as they do. That was
 * missing before -- brightness was lumens over distance squared and the lens
 * did not enter into it, so zooming changed nothing.
 *
 * Only the last step needs a decision: lux to a value the tone curve can eat.
 * This is it, and it is the only number here set by looking.
 *
 * Anchored on Paul's own rig, which is the reference to check against if this
 * ever drifts: a 10000-lumen machine, throw ratio 1.5, 1920x1200, twenty-seven
 * metres off a church. That is a 17 x 10.5 m image at **about 60 lux**, which
 * at this value reads as a projection that clearly owns the facade against a
 * dark venue -- which is what sixty lux on a wall at night looks like.
 * Sixty lux is on the dim side for mapping -- which is true of one 10k machine
 * on a facade that size, and is why real rigs stack them.
 *
 * @constant {Number}
 */
const LUX_SCALE = 0.022;

/**
 * How far a surface may sit behind what the projector saw and still count.
 *
 * **In metres**, and that is the whole point. This used to be a constant in the
 * projector's own window depth, which is not a distance: window depth runs as
 * `1 - near/d`, so a fixed slice of it is worth centimetres up close and tens
 * of metres far away. At 0.0015 with a 0.1 near plane it bought about sixteen
 * metres of slack at thirty, which is how the far side of a church came out
 * lit -- the wall behind was well inside the tolerance meant for surface acne.
 *
 * Compared in metres instead, against the linearised atlas, this means what it
 * says at any distance. Ten centimetres covers the atlas's own grain on a
 * slanted facade without letting anything real through.
 *
 * @constant {Number}
 */
const DEPTH_BIAS = 0.1;

/**
 * Samples along the view ray for the shaft.
 *
 * Twelve left a visible stipple -- the ordered dither spreads its error evenly
 * but there is still error, and on a long smooth cone the eye finds the pattern
 * at once. Twenty-four is clean, and the pass had the room: the whole thing
 * measured 1.68 ms with the shaft on, because a step costs nothing at all where
 * no projector reaches and the loop leaves early.
 *
 * @constant {Number}
 */
const SHAFT_STEPS = 32;

/**
 * How far down the ray to bother marching, metres.
 *
 * Measured from the **camera**, not from the lens: it bounds the ray being
 * walked, so on a wide shot it is the eye's distance that runs out first.
 *
 * It was seventy while the steps were spread across the whole ray -- a long
 * reach then meant a coarse stride and a stippled beam. `frustumSpan` removed
 * that trade: the march is confined to the lit stretch whatever the reach, so
 * distance is now nearly free and the cap only exists to bound the loop. Three
 * hundred metres is past any room, stage or facade, and the extinction term has
 * long since eaten the beam by then anyway.
 *
 * @constant {Number}
 */
const SHAFT_MAX = 300;

/**
 * How coarsely the picture is read in the air.
 *
 * A deliberately blurred mip, and the number that decides whether the beam
 * reads as haze or as lasers.
 *
 * At 4.5 each view ray picked up an almost pure sample of the picture, so the
 * image's colour bands came through the air as hard radial streaks -- Paul:
 * *"bright streaks its not a laser"*. Air does not work that way. Light
 * scattered off haze has bounced before it reaches the eye, and every bounce
 * mixes directions, so structure inside a beam washes out even though the same
 * picture lands crisp on the wall behind it. Reading a broad average in the air
 * is the cheap stand-in for that, and it is why this is far coarser than
 * anything the surface uses.
 *
 * It also flattens the integrand, which is what keeps the dither quiet.
 *
 * @constant {Number}
 */
const SHAFT_LOD = 8.0;

/**
 * Nearest the lens the shaft's falloff is allowed to go, metres.
 *
 * The real cause of the stipple, and not the dither it looked like. Inverse
 * square off a *point* is unbounded: clamped at 5 cm, a sample landing near the
 * lens is four hundred times one a metre away, so with the steps jittered per
 * pixel the few that land close dominate their pixel's whole sum and neighbours
 * disagree wildly. That is the grain -- and it is why it was always worst at
 * the projector end, which should have said so from the start.
 *
 * Three metres, which is further out than the physics alone would justify and
 * deliberately so. A lens has area rather than being a point, so the falloff
 * has to stop somewhere; putting it here also flattens the white core that
 * otherwise sits on the first few metres of the beam, where a ray passing close
 * to the lens picks up a couple of hundred times the light of one out at the
 * building. That core reads as a blown highlight and hides the colour, which is
 * the one thing a shaft is there to show.
 *
 * @constant {Number}
 */
const SHAFT_NEAR = 3.0;

/** How much coarser the shaft reads the haze field than the room air does. */
const SHAFT_FIELD_SCALE = 3.5;

/**
 * How much of the beam's width is edge rather than beam, in the air.
 *
 * A projector's frustum is a hard-edged solid: the picture stops at the frame,
 * and on a wall it should. In haze it should not -- scattering carries light
 * sideways out of the cone, so the boundary is a gradient rather than a cut.
 * Left sharp it reads as a laser, which is the complaint this answers. At 0.22
 * nearly a quarter of the beam's half-width is gradient, which is far more than
 * physics alone would give -- a projector's frame really is fairly hard -- but
 * it is what makes a cone read as light in air rather than as a solid.
 *
 * Applied to the shaft only. The blend ramps are the user's business and this
 * multiplies alongside them rather than replacing them.
 *
 * @constant {Number}
 */
const SHAFT_EDGE = 0.22;

/**
 * Extra mip levels per metre travelled from the lens.
 *
 * Scattering is cumulative: every metre of haze mixes a little more of each
 * direction into its neighbours, so a beam carries its picture recognisably for
 * the first few metres and is a soft coloured glow by the far end. A fixed blur
 * cannot say that -- it makes the whole shaft equally vague, including the part
 * nearest the lens where the structure really is still there.
 *
 * At roughly a tenth of a level per metre, thirty metres adds three levels on
 * top of the base, which on a 4K frame is the difference between reading the
 * picture and reading its average.
 *
 * @constant {Number}
 */
const SHAFT_BLUR_PER_METRE = 0.1;

/**
 * How fast the beam is eaten by the air it is lighting, per metre per unit haze.
 *
 * Beer-Lambert, and the piece that was missing: the shaft only ever gained
 * in-scatter and never paid extinction, so it kept its strength far past where
 * a real beam has been absorbed into the room. Tied to haze density because it
 * is the same air doing both -- thicker haze scatters more light towards the
 * eye *and* swallows the beam sooner, which is why a heavily hazed room has
 * short fat beams rather than long ones.
 *
 * Note this is on top of the inverse square, not instead of it.
 *
 * @constant {Number}
 */
const SHAFT_FADE_PER_METRE = 0.06;

/**
 * Scattering, from lux in the air to something the tone curve can use.
 *
 * Paul's value, and lower than the physics alone would suggest -- deliberately.
 * A shaft is what the haze happens to pick up, not the subject: the picture on
 * the building is what a coverage preview is for, and a beam bright enough to
 * compete with it is in the way. It started at 0.5, which put the cone's 99th
 * percentile at 245 out of 255 -- a white core with the colour boiled out of
 * it -- and came down in two steps to here at Paul's call.
 *
 * There is no separate control for this and there should not be: the haze
 * density scales it and the projector's own dimmer scales it, which is the
 * same pair of things that would move a real beam.
 *
 * @constant {Number}
 */
const SHAFT_GAIN = 0.02;

const FRAGMENT = /* glsl */`
  uniform mat4 projInverse;
  uniform mat4 camWorld;
  uniform sampler2D picture;
  uniform sampler2D depthAtlas;
  uniform mat4 lensMatrix[SLOTS];
  uniform vec4 sliceRect[SLOTS];
  uniform vec4 atlasTile[SLOTS];
  uniform vec3 emission[SLOTS];
  uniform vec3 lensPos[SLOTS];
  uniform vec4 blendEdges[SLOTS];
  uniform vec3 camPos;
  uniform float hazeMetres;
  uniform float drift;
  uniform float hazeDensity;
  uniform int liveCount;
  uniform float hasPicture;

  /**
   * How much of the picture survives this far in from an edge.
   *
   * Linear, and that is not a simplification: two machines ramping across the
   * same overlap carry t and 1-t, and this pass adds light the way projectors
   * do, so a linear pair sums to exactly one everywhere in the seam. A curve
   * would be the right answer for a real projector's gamma and black level;
   * here it would only make the join wrong.
   */
  float blendRamp(float inset, float width) {
    return width <= 0.0 ? 1.0 : clamp(inset / width, 0.0, 1.0);
  }

  /**
   * The air's density at a point, on the field every other renderer uses.
   *
   * One octave, not the two the ambient pass runs: this is called twelve times
   * per pixel inside a loop, and the second octave's job is to make still room
   * air churn -- a shaft is already moving because the picture in it is.
   */
  float shaftField(vec3 world) {
    // Read coarser than the room air is. A step down a long shaft is over a
    // metre, and the field's features are a couple of metres, so sampling it at
    // its own scale draws a fresh uncorrelated value every step -- twenty-four
    // independent draws per pixel, each pixel offset differently by the dither,
    // which is grain by construction and no amount of steps fixes it cheaply.
    // Integrating a long path physically averages the fine structure away, so
    // reading the low-frequency shape is both quieter and truer.
    vec3 coord = world / max(hazeMetres * SHAFT_FIELD_SCALE, 0.01);
    float field = abs(noiseAt(coord + vec3(drift, 0.0, 0.0))) * HAZE_FIELD_GAIN;
    return mix(1.0, field, 0.3);
  }

  /**
   * Window depth from the atlas, back to metres along the projector's axis.
   *
   * The inverse of the perspective divide the tile was drawn through. Without
   * it every comparison happens in a space where distance is not linear and no
   * single tolerance can be right at both ends of the room.
   */
  float linearDepth(float window) {
    float ndc = window * 2.0 - 1.0;
    return (2.0 * PROJ_NEAR * PROJ_FAR)
      / (PROJ_FAR + PROJ_NEAR - ndc * (PROJ_FAR - PROJ_NEAR));
  }

  /** 2x2 ordered dither, the building block of the 4x4 below. */
  float shaftBayer2(vec2 a) {
    a = floor(a);
    return fract(a.x / 2.0 + a.y * a.y * 0.75);
  }

  /**
   * 4x4 ordered dither over screen pixels.
   *
   * Offsets each pixel's first sample, so twelve steps do not draw twelve
   * shells. Ordered rather than random for the reason the ambient pass gives:
   * the same error spread evenly reads as texture, spread randomly as grain.
   */
  float shaftBayer4(vec2 a) {
    return shaftBayer2(0.5 * a) * 0.25 + shaftBayer2(a);
  }

  /**
   * What one projector puts into the air at a point, or on a surface at it.
   *
   * The same test either way -- inside the frustum, seen by the lens, through
   * the blend -- which is what keeps the shaft and the picture agreeing.
   */
  vec3 projectorAt(int i, vec3 world, float lod) {
    vec4 lens = lensMatrix[i] * vec4(world, 1.0);
    if (lens.w <= 0.0001) return vec3(0.0);

    vec3 ndc = lens.xyz / lens.w;
    if (any(greaterThan(abs(ndc), vec3(1.0)))) return vec3(0.0);

    vec2 frame = ndc.xy * 0.5 + 0.5;
    vec4 tile = atlasTile[i];
    float seen = unpackRGBAToDepth(texture2D(depthAtlas, tile.xy + frame * tile.zw));
    // Both sides in metres. lens.w already is one; the atlas holds window
    // depth, so it gets undone with the same near and far the tile was drawn
    // with -- see PROJECTOR_NEAR.
    if (lens.w > linearDepth(seen) + DEPTH_BIAS) return vec3(0.0);

    vec4 edges = blendEdges[i];
    float blend = blendRamp(frame.x, edges.x)
      * blendRamp(1.0 - frame.x, edges.y)
      * blendRamp(frame.y, edges.z)
      * blendRamp(1.0 - frame.y, edges.w);

    // How far this piece of air is from the lens, along the throw. Both the
    // blur and the fade below are functions of it, because both are the same
    // thing: light being scattered out of the beam on its way through the room.
    float travelled = lens.w;

    vec4 rect = sliceRect[i];
    // An explicit level, because this is called from inside a loop where the
    // branches above make the derivatives undefined -- and the air wants a soft
    // read of the picture anyway, growing softer the further it has come.
    float blurred = lod + travelled * SHAFT_BLUR_PER_METRE;
    vec3 colour = mix(vec3(1.0), textureLod(picture, rect.xy + frame * rect.zw, blurred).rgb, hasPicture);

    // The cone's own edge, softened. Scattering carries light out of the beam,
    // so the boundary is a gradient; a hard cut is what makes it look solid.
    vec2 toEdge = min(frame, 1.0 - frame);
    float soft = smoothstep(0.0, SHAFT_EDGE, toEdge.x) * smoothstep(0.0, SHAFT_EDGE, toEdge.y);

    float lux = emission[i].x / max(travelled * travelled, SHAFT_NEAR * SHAFT_NEAR);
    // Absorbed by the room on the way out. Thicker haze eats it sooner.
    float survives = exp(-travelled * SHAFT_FADE_PER_METRE * hazeDensity);
    return colour * lux * emission[i].y * blend * soft * survives;
  }

  /**
   * Where along the view ray a projector's frustum begins and ends.
   *
   * Clipped in homogeneous clip space against the six planes of the unit cube,
   * which is exact for an asymmetric frustum and costs six dot products -- far
   * cheaper than the samples it saves.
   *
   * This is what makes the march worth anything. Spreading the steps over the
   * whole ray spends nearly all of them on empty air: a pixel with no geometry
   * behind it marched seventy metres to catch a cone perhaps ten across, so two
   * or three samples carried the whole answer and neighbouring pixels disagreed.
   * Confining them to the lit span puts every sample where the light is.
   */
  bool frustumSpan(int i, vec3 origin, vec3 dir, float maxT, out float near, out float far) {
    vec4 a = lensMatrix[i] * vec4(origin, 1.0);
    vec4 b = lensMatrix[i] * vec4(origin + dir * maxT, 1.0);

    vec4 planes[6];
    planes[0] = vec4(1.0, 0.0, 0.0, 1.0);
    planes[1] = vec4(-1.0, 0.0, 0.0, 1.0);
    planes[2] = vec4(0.0, 1.0, 0.0, 1.0);
    planes[3] = vec4(0.0, -1.0, 0.0, 1.0);
    planes[4] = vec4(0.0, 0.0, 1.0, 1.0);
    planes[5] = vec4(0.0, 0.0, -1.0, 1.0);

    float lo = 0.0;
    float hi = 1.0;
    for (int p = 0; p < 6; p++) {
      float da = dot(planes[p], a);
      float db = dot(planes[p], b);
      if (da < 0.0 && db < 0.0) return false;
      if (da < 0.0) lo = max(lo, da / (da - db));
      else if (db < 0.0) hi = min(hi, da / (da - db));
    }
    if (hi <= lo) return false;
    near = lo * maxT;
    far = hi * maxT;
    return true;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {

    if (liveCount == 0) {
      outputColor = vec4(0.0, 0.0, 0.0, inputColor.a);
      return;
    }

    // The world point this pixel is looking at, rebuilt from the depth buffer --
    // the same reconstruction the ambient haze does.
    //
    // **Not skipped when nothing was drawn.** An empty pixel has no surface to
    // light, but it has air in it, and a beam crossing open sky is the normal
    // case for a projector on a building. Returning early here is what glued
    // the shaft to the floor: it only survived where some surface happened to
    // lie behind it. With depth at 1.0 this lands on the far plane, which is
    // exactly the ray the march wants.
    bool hasSurface = depth < 1.0;
    vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 viewPos = projInverse * clip;
    viewPos /= viewPos.w;
    vec3 world = (camWorld * viewPos).xyz;

    // The surface's facing, from how the reconstructed position moves across
    // the screen. A projector's picture falls off with the angle it strikes at,
    // and on a building that is most of what tells one wall from the next.
    vec3 surfaceNormal = normalize(cross(dFdx(world), dFdy(world)));
    // Turned to face the eye. The cross product's sign follows the triangle's
    // winding on screen, not the surface's outside, and every surface we can
    // see faces us -- so this makes the sign mean something.
    if (dot(surfaceNormal, camPos - world) < 0.0) surfaceNormal = -surfaceNormal;

    vec3 total = vec3(0.0);
    if (hasSurface) {

    for (int i = 0; i < SLOTS; i++) {
      if (i >= liveCount) break;

      // Masked rather than branched. A texture read inside per-pixel control
      // flow has undefined derivatives -- the compiler says so -- and the
      // picture needs its mip chain, so every fragment takes the same path and
      // the rejections become multipliers.
      vec4 lens = lensMatrix[i] * vec4(world, 1.0);
      // A projector throws forwards only.
      float inFront = step(0.0001, lens.w);
      vec3 ndc = lens.xyz / max(lens.w, 0.0001);
      float widest = max(max(abs(ndc.x), abs(ndc.y)), abs(ndc.z));
      float inside = inFront * step(widest, 1.0);

      vec2 frame = clamp(ndc.xy * 0.5 + 0.5, 0.0, 1.0);

      // Does the projector actually see this point, or is something in the way?
      vec4 tile = atlasTile[i];
      float seen = unpackRGBAToDepth(texture2D(depthAtlas, tile.xy + frame * tile.zw));
      float visible = step(lens.w, linearDepth(seen) + DEPTH_BIAS);

      // The slice of the frame this machine is fed.
      vec4 rect = sliceRect[i];
      vec3 colour = mix(vec3(1.0), texture2D(picture, rect.xy + frame * rect.zw).rgb, hasPicture);

      // Illuminance falls with the square of the distance because the same
      // lumens are spread over a bigger picture -- that is the projector's own
      // throw maths, not an invented falloff. Emission carries lumens and the
      // lens shape; the distance is whatever the geometry turned out to be.
      float throwDistance = max(lens.w, 0.05);
      float lux = emission[i].x / (throwDistance * throwDistance);

      // Straight on is full value, edge on is nothing, facing away is nothing at
      // all -- measured to the lens, which is what lights this surface.
      //
      // This used to take the magnitude and then floor it at 0.15, on the
      // grounds that the reconstructed normal's winding was unknown. Both were
      // wrong: the magnitude lights a wall that faces away as brightly as one
      // that faces the lens, and the floor guaranteed light on every surface in
      // the frustum whatever its angle. The winding is not unknown either -- we
      // are looking at this surface, so its outward normal is the one pointing
      // back at the camera, and from there the sign means something.
      vec3 toLens = normalize(lensPos[i] - world);
      float facing = max(dot(surfaceNormal, toLens), 0.0);

      // Soft edge. Applied on the projector's own frame, which is where a real
      // blend lives -- it is the machine dimming its own picture towards an
      // edge, not something happening out on the wall.
      vec4 edges = blendEdges[i];
      float blend = blendRamp(frame.x, edges.x)
        * blendRamp(1.0 - frame.x, edges.y)
        * blendRamp(frame.y, edges.z)
        * blendRamp(1.0 - frame.y, edges.w);

      total += colour * lux * emission[i].y * facing * inside * visible * blend;
    }
    }

    // The shaft: the same question asked of the air between the eye and that
    // surface, rather than only of the surface itself.
    if (hazeDensity > 0.0) {
      vec3 ray = world - camPos;
      float reach = min(length(ray), SHAFT_MAX);
      vec3 direction = normalize(ray);

      // The stretch of this ray any projector could light, so no step is spent
      // outside it. Bounded by the surface, so a wall still stops the shaft.
      float spanNear = reach;
      float spanFar = 0.0;
      for (int i = 0; i < SLOTS; i++) {
        if (i >= liveCount) break;
        float near;
        float far;
        if (frustumSpan(i, camPos, direction, reach, near, far)) {
          spanNear = min(spanNear, near);
          spanFar = max(spanFar, far);
        }
      }

      float stride = max(spanFar - spanNear, 0.0) / float(SHAFT_STEPS);
      float jitter = shaftBayer4(gl_FragCoord.xy);

      vec3 scattered = vec3(0.0);
      for (int step = 0; step < SHAFT_STEPS; step++) {
        vec3 at = camPos + direction * (spanNear + (float(step) + jitter) * stride);

        vec3 lit = vec3(0.0);
        for (int i = 0; i < SLOTS; i++) {
          if (i >= liveCount) break;
          lit += projectorAt(i, at, SHAFT_LOD);
        }

        // The field is only worth fetching where something is lighting the air.
        if (lit.r + lit.g + lit.b > 0.0) {
          scattered += lit * shaftField(at) * stride;
        }
      }
      total += scattered * hazeDensity * SHAFT_GAIN;
    }

    outputColor = vec4(total, inputColor.a);
  }
`;

class ProjectorEffect extends Effect {
  /**
   * @param {Object} camera the scene camera, for rebuilding world position
   */
  constructor(camera) {
    const lensMatrix = [];
    const sliceRect = [];
    const atlasTile = [];
    const emission = [];
    const lensPos = [];
    const blendEdges = [];
    for (let i = 0; i < MAX_PROJECTIONS; i += 1) {
      lensMatrix.push(new THREE.Matrix4());
      sliceRect.push(new THREE.Vector4(0, 0, 1, 1));
      const tile = ProjectorDepth.tileUv(i);
      atlasTile.push(new THREE.Vector4(tile.x, tile.y, tile.width, tile.height));
      emission.push(new THREE.Vector3(0, 0, 0));
      lensPos.push(new THREE.Vector3());
      blendEdges.push(new THREE.Vector4(0, 0, 0, 0));
    }

    super('ProjectorEffect', hazeShaderPrelude() + FRAGMENT, {
      blendFunction: BlendFunction.ADD,
      // Without this the pass has no depth buffer, and every projector would
      // paint the sky as readily as the building.
      attributes: EffectAttribute.DEPTH,
      defines: new Map([
        ['SLOTS', `${MAX_PROJECTIONS}`],
        ['DEPTH_BIAS', DEPTH_BIAS.toFixed(4)],
        ['PROJ_NEAR', PROJECTOR_NEAR.toFixed(4)],
        ['PROJ_FAR', PROJECTOR_FAR.toFixed(1)],
        ['SHAFT_STEPS', `${SHAFT_STEPS}`],
        ['SHAFT_MAX', SHAFT_MAX.toFixed(1)],
        ['SHAFT_GAIN', SHAFT_GAIN.toFixed(3)],
        ['SHAFT_LOD', SHAFT_LOD.toFixed(2)],
        ['SHAFT_NEAR', SHAFT_NEAR.toFixed(3)],
        ['SHAFT_FIELD_SCALE', SHAFT_FIELD_SCALE.toFixed(3)],
        ['SHAFT_EDGE', SHAFT_EDGE.toFixed(3)],
        ['SHAFT_BLUR_PER_METRE', SHAFT_BLUR_PER_METRE.toFixed(4)],
        ['SHAFT_FADE_PER_METRE', SHAFT_FADE_PER_METRE.toFixed(4)],
      ]),
      uniforms: new Map([
        ['projInverse', new THREE.Uniform(new THREE.Matrix4())],
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['picture', new THREE.Uniform(null)],
        ['depthAtlas', new THREE.Uniform(null)],
        ['lensMatrix', new THREE.Uniform(lensMatrix)],
        ['sliceRect', new THREE.Uniform(sliceRect)],
        ['atlasTile', new THREE.Uniform(atlasTile)],
        ['emission', new THREE.Uniform(emission)],
        ['lensPos', new THREE.Uniform(lensPos)],
        ['blendEdges', new THREE.Uniform(blendEdges)],
        ['liveCount', new THREE.Uniform(0)],
        ['hasPicture', new THREE.Uniform(0)],
        ['camPos', new THREE.Uniform(new THREE.Vector3())],
        ['hazeMetres', new THREE.Uniform(SceneEnv.hazeScale)],
        ['drift', new THREE.Uniform(0)],
        ['hazeDensity', new THREE.Uniform(0)],
        // Shared by reference with every other renderer: one volume, one
        // cycling amount, so the air a shaft lights is the air the beams light.
        ...Object.entries(hazeUniforms()).map(([name, uniform]) => [name, uniform]),
      ]),
    });

    this.camera = camera;
    this.projections = [];
    this.picture = null;
    this.elapsed = 0;
  }

  /**
   * Hands the pass what to draw this frame.
   *
   * Called from the render loop rather than pulled from here, because the
   * projections come from the fixture layer and the pass has no business
   * reaching into it.
   *
   * @public
   * @param {Array} projections each `{ lensMatrix, rect, lumensPerArea, gain }`
   * @param {Object} picture the decoded video texture, or null
   */
  setProjections(projections, picture) {
    this.projections = projections || [];
    this.picture = picture || null;
  }

  /**
   * @public
   */
  update(renderer, inputBuffer, deltaTime) {
    this.elapsed += deltaTime || 0;

    const { uniforms, camera } = this;
    if (camera) {
      camera.updateMatrixWorld();
      uniforms.get('projInverse').value.copy(camera.projectionMatrixInverse);
      uniforms.get('camWorld').value.copy(camera.matrixWorld);
      uniforms.get('camPos').value.setFromMatrixPosition(camera.matrixWorld);
    }

    // `hazeAmount`, not `roomHaze`: a projector lighting its own cone is a
    // fixture, and a fixture's beam stays when the house lights come up.
    uniforms.get('hazeDensity').value = SceneEnv.hazeAmount;
    uniforms.get('hazeMetres').value = SceneEnv.hazeScale;
    // The same drift convention the beams and the ambient air use.
    uniforms.get('drift').value = (this.elapsed * SceneEnv.hazeTurbulence) / 15;

    const live = this.projections.slice(0, MAX_PROJECTIONS);
    uniforms.get('liveCount').value = live.length;
    uniforms.get('picture').value = this.picture;
    uniforms.get('hasPicture').value = this.picture ? 1 : 0;
    uniforms.get('depthAtlas').value = ProjectorDepth.texture();

    const matrices = uniforms.get('lensMatrix').value;
    const rects = uniforms.get('sliceRect').value;
    const emission = uniforms.get('emission').value;
    const lensPos = uniforms.get('lensPos').value;
    const blendEdges = uniforms.get('blendEdges').value;
    live.forEach((projection, i) => {
      const { blend } = projection;
      blendEdges[i].set(blend.left, blend.right, blend.bottom, blend.top);
      lensPos[i].setFromMatrixPosition(projection.camera.matrixWorld);
      matrices[i].copy(projection.lensMatrix);
      rects[i].set(
        projection.rect.x,
        projection.rect.y,
        projection.rect.width,
        projection.rect.height,
      );
      // x carries the lumens, y the dimmer and shutter folded together. Kept
      // apart so a dimmed machine still reads as the same machine.
      emission[i].set(projection.lumensPerArea * LUX_SCALE, projection.gain, 0);
    });
  }
}

export default ProjectorEffect;
