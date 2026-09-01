import * as THREE from 'three';

/**
 * @file Draws a video feed's texture, whichever way the pixels are packed.
 *
 * A feed arrives as either plain RGBA or as UYVY, and the difference cannot be
 * hidden behind a texture: UYVY packs **two pixels into four bytes** (U Y0 V
 * Y1), so the texture is half the width of the picture and a sampler pointed
 * at it returns two luma samples and a shared chroma pair rather than a
 * colour. Unpacking is the shader's job.
 *
 * Which is a bargain, not a chore. NDI's wire format is YUV 4:2:2, so asking
 * the SDK for RGBA makes it convert on the CPU *and* doubles what has to be
 * uploaded -- measured at ~9.7 ms a frame for 4K. This moves the colour
 * transform to the GPU, where it costs nothing worth measuring, and halves the
 * bytes crossing the bus.
 */

/**
 * BT.709, studio swing -- which is what NDI carries for HD and UHD.
 *
 * Full-range video decoded with these constants looks slightly crushed at both
 * ends rather than obviously wrong, which is the kind of error that survives a
 * long time. If a source ever looks flat, this is the first suspect.
 */
const UYVY_FRAGMENT = /* glsl */`
  uniform sampler2D packed;
  uniform vec2 pictureSize;
  varying vec2 vUv;

  void main() {
    // Which picture pixel this fragment wants, and which half of its texel
    // that pixel occupies.
    float x = vUv.x * pictureSize.x;
    float pair = floor(x * 0.5);
    bool second = mod(floor(x), 2.0) >= 1.0;

    // Sampled at the texel's centre. Nearest filtering is not enough on its
    // own: a sampler asked for a point between two packed texels would blend
    // a luma with a chroma, so the coordinate is snapped rather than trusted.
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
    #include <colorspace_fragment>
  }
`;

const UYVY_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * A material that draws whatever the feed is currently carrying.
 *
 * The texture is passed separately because a texture belongs to the WebGL
 * context that uploaded it: the slicing popup renders the same feed in a
 * context of its own and supplies its own.
 *
 * @param {Object} feed anything with `format`, `width`, `height`
 * @param {THREE.Texture} [texture] defaults to the feed's own
 * @returns {THREE.Material}
 */
export default function createVideoMaterial(feed, texture = feed.texture) {
  if (feed.format !== 'UYVY') {
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      packed: { value: texture },
      pictureSize: { value: new THREE.Vector2(feed.width, feed.height) },
    },
    vertexShader: UYVY_VERTEX,
    fragmentShader: UYVY_FRAGMENT,
    // Video is already the picture; the tone curve is for scene light.
    toneMapped: false,
  });
}
