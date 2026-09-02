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
  // How much of the picture comes out: a dimmer and a blanked screen are the
  // same thing seen from the glass, so they fold into one number.
  uniform float gain;
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
      (y + 1.792741 * v) * gain,
      (y - 0.213249 * u - 0.532909 * v) * gain,
      (y + 2.112402 * u) * gain,
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
 * The pixel grid, bolted onto whichever unpacking the feed needs.
 *
 * A display is not a smooth surface: it is a grid of emitters with dark ground
 * between them, and at any distance where you can see that grid it is most of
 * what makes a video wall look like one rather than like a poster. Two things
 * do the work:
 *
 * - **The sample is quantised to the panel's own pixels**, so the picture takes
 *   the wall's resolution rather than the feed's. Feeding a 1920-wide source to
 *   a 128-wide wall should look like 128 pixels, and this is what makes it.
 * - **A gap is drawn between them**, as a fraction of the pitch. Real panels
 *   are mostly dark: the emitter is a fraction of a millimetre in a 2-4 mm
 *   cell, and rendering them edge to edge is why naive LED walls look like
 *   plastic sheet.
 *
 * `fill` at 1 turns the grid off entirely, which is right for an LCD -- its
 * pixels do meet -- and for any wall seen from far enough away that the grid is
 * below a screen pixel. Nothing is gained by drawing a grid finer than the
 * display it is drawn on.
 */
const GRID_PRELUDE = /* glsl */`
  uniform vec2 panelPixels;
  uniform vec2 fill;
  // The panel's grid lives on the panel, not in the picture. A connector hands
  // the screen a slice of a frame, so the texture coordinate runs across only
  // that slice -- driving the grid with it drew rect.width * pixelsWide cells
  // instead of pixelsWide, which on a narrow slice is a handful of stretched
  // columns rather than a wall. These two are the picture-space step for one
  // unit of panel coordinate, so a cell centre found on the panel can be
  // carried back into the picture.
  uniform vec2 pictureAxisX;
  uniform vec2 pictureAxisY;

  /**
   * How thin the dark **gap** may get, in screen pixels, before the grid is
   * given up on.
   *
   * Measured on the gap rather than on the cell, because the gap is what has to
   * be drawn: a panel at 90% fill has a hairline between its pixels and will
   * beat against the raster while its cells are still comfortably large, where
   * one at 50% fill stays clean down to much smaller cells. Judging by cell
   * size got this wrong in exactly the band that matters -- far enough that the
   * gaps have stopped reading as gaps, close enough that they still form a
   * pattern.
   *
   * Fully smooth at or below one screen pixel of gap, full grid at two and a
   * half, eased between. There is no sample count that fixes moire; the answer
   * is to stop drawing a detail finer than the display can carry.
   */
  const float GAP_FADE_TO = 1.0;
  const float GAP_FADE_FROM = 2.5;

  /**
   * How few screen pixels a **cell** may cover before the panel stops being
   * sampled per pixel and simply draws the picture.
   *
   * A separate question from the gaps above, and the one that was missed.
   * Quantising to pixel centres is right while the cells are resolvable -- it
   * is what gives a wall its blockiness -- but once a cell is smaller than a
   * fragment, floor() jumps between distant texels from one fragment to the
   * next and the panel grid beats against the picture. That is a hatched
   * diagonal moire straight through the image, and no amount of fading the
   * *gaps* touches it, because the damage is in where the colour was read from.
   *
   * Past this the fragment's own coordinate is used, which is to say: at a
   * distance, just render the bitmap.
   */
  const float CELL_FADE_TO = 1.0;
  const float CELL_FADE_FROM = 2.5;

  /** The centre of the panel pixel this fragment falls in, in panel space. */
  vec2 panelCentre(vec2 panelUv) {
    return (floor(panelUv * panelPixels) + 0.5) / panelPixels;
  }

  /** How much each axis has given up on drawing the grid, and on the cells. */
  void panelFades(vec2 panelUv, out vec2 gapGive, out vec2 cellGive) {
    // Taken on the un-wrapped coordinate: fract() has a discontinuity every
    // cell, and a derivative across it spikes to the full period.
    vec2 step = fwidth(panelUv * panelPixels);
    vec2 cellPixels = 1.0 / max(step, vec2(1e-6));
    vec2 gapPixels = (1.0 - fill) * cellPixels;
    gapGive = vec2(1.0) - smoothstep(vec2(GAP_FADE_TO), vec2(GAP_FADE_FROM), gapPixels);
    cellGive = vec2(1.0) - smoothstep(vec2(CELL_FADE_TO), vec2(CELL_FADE_FROM), cellPixels);
  }

  /**
   * Where to read the picture: the cell's centre while cells are resolvable,
   * the fragment's own coordinate once they are not.
   */
  vec2 panelSample(vec2 panelUv, vec2 pictureUv, vec2 cellGive) {
    // Snapped on the panel, then carried into the picture along the mapping's
    // own axes -- the slice may be rotated or flipped, so the offset cannot
    // simply be added to the texture coordinate.
    vec2 step = panelCentre(panelUv) - panelUv;
    vec2 snapped = pictureUv + pictureAxisX * step.x + pictureAxisY * step.y;
    return mix(snapped, pictureUv, cellGive);
  }

  /** 1 inside the emitter, 0 in the dark ground between them. */
  float panelMask(vec2 panelUv, vec2 gapGive) {
    if (fill.x >= 0.999 && fill.y >= 0.999) return 1.0;

    vec2 texel = panelUv * panelPixels;
    vec2 cell = fract(texel) - 0.5;
    vec2 edge = fill * 0.5;
    vec2 blur = fwidth(texel) * 0.5 + 1e-5;
    vec2 inside = smoothstep(edge + blur, edge - blur, abs(cell));

    // **Each axis decides for itself.** A wall built out of vertical bars has
    // cells far wider than they are tall, so its columns are plainly visible
    // while its rows are already sub-pixel -- and judging both by the tighter
    // one threw away gaps that were perfectly drawable. This keeps the columns
    // and dissolves the rows, which is what the thing actually looks like.
    //
    // Faded towards each axis's own duty cycle, not towards solid. That is what
    // the eye integrates once the gap stops resolving, so brightness is
    // preserved: fading to 1 would make a wall get *brighter* as it receded,
    // which is very visible when one wall spans two distances.
    vec2 blended = mix(inside, fill, gapGive);
    return blended.x * blended.y;
  }
`;

/**
 * A material that draws a picture as a panel of discrete pixels.
 *
 * Takes a **plain texture**, not a feed: by the time the scene draws anything
 * the bytes have been unpacked into a filterable RGBA copy with a mip chain --
 * see `video_decode.js`. That is what removed the UYVY branch that used to live
 * here, and with it the reason this shader could not simply sample.
 *
 * @param {THREE.Texture} picture the decoded frame
 * @param {Object} panel `{ pixelsWide, pixelsHigh, fillX, fillY }`
 * @returns {THREE.Material}
 */
export function createPanelMaterial(picture, panel) {
  const pixels = new THREE.Vector2(
    Math.max(Number(panel.pixelsWide) || 1, 1),
    Math.max(Number(panel.pixelsHigh) || 1, 1),
  );
  // Per axis: cells are only square when the panel's shape and its pixel grid
  // agree, and plenty of walls are built where they do not.
  const fill = new THREE.Vector2(
    Math.min(Math.max(Number(panel.fillX) || 1, 0), 1),
    Math.min(Math.max(Number(panel.fillY) || 1, 0), 1),
  );

  const fragment = /* glsl */`
    uniform sampler2D picture;
    uniform float gain;
    varying vec2 vUv;
    varying vec2 vPanelUv;
    ${GRID_PRELUDE}

    void main() {
      // Sampled at the cell's centre while the cells are big enough to see --
      // every fragment inside one panel pixel must show the same colour, or the
      // grid is drawn over a smooth image and fools nobody. Once they are not,
      // the picture is read at the fragment instead, and the texture's own mip
      // chain does the averaging. See panelFades().
      vec2 gapGive;
      vec2 cellGive;
      panelFades(vPanelUv, gapGive, cellGive);
      vec3 colour = texture2D(picture, panelSample(vPanelUv, vUv, cellGive)).rgb;
      gl_FragColor = vec4(colour * gain * panelMask(vPanelUv, gapGive), 1.0);
      #include <colorspace_fragment>
    }
  `;

  // Its own, because it carries the panel coordinate alongside the picture's.
  const vertex = /* glsl */`
    varying vec2 vUv;
    varying vec2 vPanelUv;
    attribute vec2 panelUv;
    void main() {
      vUv = uv;
      vPanelUv = panelUv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  return new THREE.ShaderMaterial({
    uniforms: {
      picture: { value: picture },
      panelPixels: { value: pixels },
      fill: { value: fill },
      gain: { value: 1 },
      // Overwritten whenever the connector's rectangle is written.
      pictureAxisX: { value: new THREE.Vector2(1, 0) },
      pictureAxisY: { value: new THREE.Vector2(0, 1) },
    },
    vertexShader: vertex,
    fragmentShader: fragment,
    // The picture is already the picture; the tone curve is for scene light.
    toneMapped: false,
  });
}

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
    // A plain map is multiplied by the material's colour, so white is unity and
    // a grey is a gain -- the same knob the shader below spells out.
    return new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      packed: { value: texture },
      pictureSize: { value: new THREE.Vector2(feed.width, feed.height) },
      gain: { value: 1 },
    },
    vertexShader: UYVY_VERTEX,
    fragmentShader: UYVY_FRAGMENT,
    // Video is already the picture; the tone curve is for scene light.
    toneMapped: false,
  });
}
