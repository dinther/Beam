import * as THREE from 'three';

/**
 * @file Turns each video feed into an ordinary, filterable texture, once a frame.
 *
 * **Why this exists.** NDI's wire format is YUV 4:2:2, which arrives packed as
 * UYVY: two pixels in four bytes. A sampler pointed at that returns two luma
 * samples and a shared chroma pair rather than a colour, so the texture has to
 * be read with `NearestFilter` and cannot carry mipmaps -- blending a luma with
 * a chroma is garbage. That constraint is fine while a screen fills the view
 * and ruinous the moment it does not: a 3840-wide picture drawn onto a 170-pixel
 * wall picks one texel out of twenty-two by twenty, with nothing to average
 * them, which is textbook minification aliasing. On a source with diagonal
 * structure it reads as a hatched diagonal moire straight through the image.
 *
 * Unpacking once into an RGBA target fixes it at the root: what the scene
 * samples afterwards is a plain texture with linear filtering and a full mip
 * chain, so a distant screen averages the pixels it covers instead of picking
 * one. It also means the UYVY maths lives in exactly one place rather than in
 * every material that wants to draw video.
 *
 * **This does not go through the composer.** It renders straight to its own
 * target with its own tiny scene, so nothing here interacts with tone mapping,
 * bloom or the depth buffer -- it is a format conversion, not a pass.
 *
 * The colour transfer is deliberately left exactly where it was: the shader
 * writes the same gamma-encoded R'G'B' the old material did, the target is
 * marked as carrying no colour space, and the *consumer* still applies
 * `colorspace_fragment`. Mip averaging in gamma space is not strictly correct
 * -- linear would be -- but it is what everything else does, and reproducing
 * the existing look was worth more here than a change nobody asked for.
 */

/**
 * BT.709, studio swing, which is what NDI carries for HD and UHD.
 *
 * Lifted unchanged from `video_material.js`, which is where it used to run once
 * per fragment of every screen rather than once per pixel of the source.
 */
const UNPACK_FRAGMENT = /* glsl */`
  uniform sampler2D packed;
  uniform vec2 pictureSize;
  uniform bool unpackUYVY;
  varying vec2 vUv;

  void main() {
    if (!unpackUYVY) {
      gl_FragColor = vec4(texture2D(packed, vUv).rgb, 1.0);
      return;
    }

    // Which picture pixel this fragment wants, and which half of its texel
    // that pixel occupies.
    float x = vUv.x * pictureSize.x;
    float pair = floor(x * 0.5);
    bool second = mod(floor(x), 2.0) >= 1.0;

    // Sampled at the texel's centre. Nearest filtering is not enough on its
    // own: a sampler asked for a point between two packed texels would blend a
    // luma with a chroma, so the coordinate is snapped rather than trusted.
    vec2 uv = vec2((pair + 0.5) / (pictureSize.x * 0.5), vUv.y);
    vec4 texel = texture2D(packed, uv);

    // U Y0 V Y1 in memory, which arrives in that order as r g b a.
    float y = second ? texel.a : texel.g;
    float u = texel.r - 0.5;
    float v = texel.b - 0.5;

    y = (y - 0.0625) * 1.164383;
    gl_FragColor = vec4(
      y + 1.792741 * v,
      y - 0.213249 * u - 0.532909 * v,
      y + 2.112402 * u,
      1.0
    );
  }
`;

const UNPACK_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** One quad, one camera, one material: shared by every feed. */
let scene = null;
let camera = null;
let material = null;

/** The decoded target per feed, keyed by the feed itself. */
const targets = new WeakMap();

/** Which frame each feed was last decoded at, so a still picture costs nothing. */
const decodedAt = new WeakMap();

/** What the hardware will give us, read once from the renderer. */
let maxAnisotropy = 0;

function ensureScene() {
  if (scene) return;
  material = new THREE.ShaderMaterial({
    uniforms: {
      packed: { value: null },
      pictureSize: { value: new THREE.Vector2(1, 1) },
      unpackUYVY: { value: true },
    },
    vertexShader: UNPACK_VERTEX,
    fragmentShader: UNPACK_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    // The picture is already the picture; the tone curve is for scene light.
    toneMapped: false,
  });
  // Clip coordinates straight from the vertex shader, so no camera transform is
  // involved and the quad always covers the target exactly.
  scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  camera = new THREE.Camera();
}

/**
 * The target a feed decodes into, made or resized as needed.
 *
 * @param {Object} feed
 * @returns {Object|null} a WebGLRenderTarget
 */
function targetFor(feed) {
  const width = Math.max(Math.round(feed.width) || 0, 1);
  const height = Math.max(Math.round(feed.height) || 0, 1);
  let target = targets.get(feed);
  if (target && (target.width !== width || target.height !== height)) {
    target.dispose();
    target = null;
  }
  if (!target) {
    target = new THREE.WebGLRenderTarget(width, height, {
      // The whole point: a filterable texture with something to average.
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
      // The consumer still applies `colorspace_fragment`, exactly as it did
      // when it unpacked the bytes itself. Marking this as sRGB would convert
      // twice and wash every screen out.
      colorSpace: THREE.NoColorSpace,
      anisotropy: maxAnisotropy,
    });
    targets.set(feed, target);
  }
  return target;
}

export default {
  /**
   * Unpacks every feed that has a new frame.
   *
   * Driven from the render loop, because decoding needs a renderer and a feed
   * has no access to one -- the same reason the DMX texture's partial upload is
   * flushed from there.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Array} feeds every open feed
   */
  decodeAll(renderer, feeds) {
    if (!renderer || !feeds || !feeds.length) return;
    ensureScene();
    // Asked of the renderer once: a screen is almost never seen square on, and
    // trilinear alone picks its level from the *longer* axis of the footprint.
    // On a wall at a steep angle that either blurs it to mush or, where the
    // level is too low, leaves the compressed axis aliasing exactly as before.
    // Anisotropic filtering is what makes a mip chain useful on a surface you
    // are looking across rather than at.
    if (maxAnisotropy === 0) maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    const previousTarget = renderer.getRenderTarget();
    feeds.forEach((feed) => {
      if (!feed || !feed.texture || !feed.width || !feed.height) return;
      // A still picture costs nothing: the decode is per *arrived* frame, not
      // per drawn frame, so a paused sender does not pay for mip generation
      // sixty times a second.
      if (decodedAt.get(feed) === feed.frameCount) return;
      decodedAt.set(feed, feed.frameCount);

      const target = targetFor(feed);
      material.uniforms.packed.value = feed.texture;
      material.uniforms.pictureSize.value.set(feed.width, feed.height);
      material.uniforms.unpackUYVY.value = feed.format === 'UYVY';
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    });
    renderer.setRenderTarget(previousTarget);
  },

  /**
   * The texture a feed should be drawn from, or null before the first frame.
   *
   * @public
   * @param {Object} feed
   * @returns {Object|null}
   */
  textureFor(feed) {
    const target = feed && targets.get(feed);
    return target ? target.texture : null;
  },

  /**
   * Lets go of a feed's target.
   *
   * @public
   * @param {Object} feed
   */
  release(feed) {
    const target = targets.get(feed);
    if (!target) return;
    target.dispose();
    targets.delete(feed);
    decodedAt.delete(feed);
  },
};
