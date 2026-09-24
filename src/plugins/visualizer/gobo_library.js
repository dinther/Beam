import * as THREE from 'three';
import GOBOS from './gobo_manifest';

/**
 * @file The gobo patterns every beam can project, in one atlas texture.
 *
 * A gobo is a stencil in the beam. The images are the Open Fixture
 * Library's own, shipped in `public/gobos` and listed in `gobo_manifest.js`;
 * a profile's wheel slot names one as `gobos/<name>`. Any beam reads its
 * gobo by pattern index, in the air and on the surfaces it lands on, from
 * the same texture.
 *
 * A slot that names an image gets it. A slot that names nothing, which is
 * most of them since few profiles reference OFL images at all, gets images
 * by slot order, so every gobo wheel shows something different in each slot.
 *
 * Pattern 0 is fully open and is what an open slot or a fixture without a
 * gobo wheel reads, so the shaders never read the atlas for it.
 *
 * **One rule for every image.** The OFL images come in two conventions:
 * black shapes on a transparent ground, and black on white. Composited over
 * white both read the same way, black the metal and white where light
 * passes, and glass comes out as the grey of its transmission. The images
 * carry no colour into the beam; a coloured glass gobo projects as a grey
 * pattern.
 */

/** Pixels across one pattern in the atlas. */
const GOBO_SIZE = 128;

/**
 * Patterns across and down the atlas: 64 cells, pattern 0 open and the 46
 * OFL images after it, with room to spare. At 128 px a cell the atlas is
 * 1024 px square, the same memory as the twelve 256 px patterns it
 * replaced.
 */
export const GOBO_GRID = 8;

/**
 * The blur each level of the atlas is baked with, as a Gaussian's sigma in
 * the pattern's pixels: level 0 is sharp, the last is a gobo with the focus
 * wound fully out. Baked once, on the CPU, with the canvas's own blur, so a
 * defocused gobo is a true smooth blur: blurring in the shader either showed
 * a coarse mip's texels as blocks or, as a disc of taps, smeared copies.
 *
 * Three, because a stencil is one grey value and the atlas's pixels have
 * three colour channels: level i lives in channel i, so every level shares
 * one square image and one read returns them all.
 */
const GOBO_BLUR_SIGMAS = [0, 2.5, 7];

/** How many blur levels the atlas holds, one per colour channel. */
export const GOBO_BLUR_LEVELS = GOBO_BLUR_SIGMAS.length;

/**
 * The round aperture every image is cut to, as a fraction of its cell's
 * half-width: a little inside the edge, so a disc drawn a hair short of it
 * leaves no ring of light.
 */
const GOBO_APERTURE = 0.96;

/** Where the images are served from, as the fixture profiles are. */
const GOBO_URL = `${import.meta.env.VITE_STATIC_URL || ''}gobos/`;

let texture = null;
let canvas = null;

/**
 * Where the image's metal disc sits, as a box in fractions of the image:
 * the bounds of its dark pixels. Several images draw the disc short of
 * their edge on a white ground, and not always centred, so the margin
 * differs side to side. For an image dark to its edges, or whose dark
 * pixels are a pattern rather than a disc (a margin over 8% on any side, or
 * a box far from square), the whole image.
 *
 * @param {HTMLImageElement} image
 * @returns {Object} `{ x, y, w, h }` in fractions of the image
 */
function discBox(image) {
  const size = 256;
  const probe = document.createElement('canvas');
  probe.width = size;
  probe.height = size;
  const p = probe.getContext('2d');
  p.fillStyle = '#fff';
  p.fillRect(0, 0, size, size);
  p.drawImage(image, 0, 0, size, size);
  const px = p.getImageData(0, 0, size, size).data;
  let minX = size; let minY = size; let maxX = -1; let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (px[(y * size + x) * 4] < 64) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const whole = {
    x: 0, y: 0, w: 1, h: 1,
  };
  if (maxX < 0) return whole;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const margin = Math.max(minX, minY, size - 1 - maxX, size - 1 - maxY) / size;
  if (margin > 0.08 || Math.abs(w - h) > size * 0.03) return whole;
  return {
    x: minX / size, y: minY / size, w: w / size, h: h / size,
  };
}

/**
 * Draws the sharp patterns: open in cell 0, each loaded image in its cell,
 * composited over white so black is metal and the rest passes light.
 *
 * @param {Array} images HTMLImageElement or null per manifest entry
 * @returns {HTMLCanvasElement}
 */
function drawSharp(images) {
  const size = GOBO_SIZE * GOBO_GRID;
  const sharp = document.createElement('canvas');
  sharp.width = size;
  sharp.height = size;
  const s = sharp.getContext('2d');
  s.fillStyle = '#000';
  s.fillRect(0, 0, size, size);
  s.fillStyle = '#fff';
  s.fillRect(0, 0, GOBO_SIZE, GOBO_SIZE);
  // A proper downscale: the images are 1024 px, and the default filter
  // samples a few source pixels per cell pixel, which drew round dots as
  // ragged polygons.
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = 'high';
  images.forEach((image, i) => {
    if (!image) return;
    const index = i + 1;
    const x = (index % GOBO_GRID) * GOBO_SIZE;
    const y = Math.floor(index / GOBO_GRID) * GOBO_SIZE;
    // Placed so the metal disc fills the cell, centred. Several images draw
    // the disc short of their edge and off centre, and that margin passed
    // light as a thin crescent round the pool that turned with the gobo.
    const box = discBox(image);
    const scaleX = GOBO_SIZE / box.w;
    const scaleY = GOBO_SIZE / box.h;
    s.save();
    s.beginPath();
    s.rect(x, y, GOBO_SIZE, GOBO_SIZE);
    s.clip();
    s.fillStyle = '#fff';
    s.fillRect(x, y, GOBO_SIZE, GOBO_SIZE);
    s.drawImage(image, x - box.x * scaleX, y - box.y * scaleY, scaleX, scaleY);
    // Nothing passes outside the round aperture, whatever the image has
    // there: white corners, and any sliver of ground between a disc drawn a
    // hair short and the edge, otherwise showed as a faint ring round the
    // pool, worse once the focus blur spread the corners inwards.
    const centre = GOBO_SIZE / 2;
    s.fillStyle = '#000';
    s.beginPath();
    s.rect(x, y, GOBO_SIZE, GOBO_SIZE);
    s.arc(x + centre, y + centre, centre * GOBO_APERTURE, 0, Math.PI * 2);
    s.fill('evenodd');
    s.restore();
  });
  return sharp;
}

/**
 * Packs the sharp patterns and their blurred copies into the atlas canvas:
 * red sharp, green and blue blurred. Each cell is blurred inside its own
 * clip, so a blur never pulls a neighbouring pattern into it.
 *
 * @param {HTMLCanvasElement} sharp
 */
function pack(sharp) {
  const size = sharp.width;
  const work = document.createElement('canvas');
  work.width = size;
  work.height = size;
  const w = work.getContext('2d');
  const c = canvas.getContext('2d');
  const packed = c.createImageData(size, size);
  GOBO_BLUR_SIGMAS.forEach((sigma, level) => {
    w.fillStyle = '#000';
    w.fillRect(0, 0, size, size);
    for (let index = 0; index < GOBO_GRID * GOBO_GRID; index += 1) {
      const x = (index % GOBO_GRID) * GOBO_SIZE;
      const y = Math.floor(index / GOBO_GRID) * GOBO_SIZE;
      w.save();
      w.beginPath();
      w.rect(x, y, GOBO_SIZE, GOBO_SIZE);
      w.clip();
      w.filter = sigma > 0 ? `blur(${sigma}px)` : 'none';
      w.drawImage(sharp, x, y, GOBO_SIZE, GOBO_SIZE, x, y, GOBO_SIZE, GOBO_SIZE);
      w.restore();
    }
    const pixels = w.getImageData(0, 0, size, size).data;
    // Luminance, so a glass gobo passes its grey whatever its tint.
    for (let i = 0; i < pixels.length; i += 4) {
      packed.data[i + level] = 0.3 * pixels[i] + 0.59 * pixels[i + 1] + 0.11 * pixels[i + 2];
    }
  });
  for (let i = 3; i < packed.data.length; i += 4) packed.data[i] = 255;
  c.putImageData(packed, 0, 0);
}

/**
 * Loads one image, resolving to null if it cannot be read, so one bad file
 * leaves one dark cell rather than no gobos at all.
 *
 * @param {String} file
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadImage(file) {
  return new Promise((resolve) => {
    const image = new Image();
    // Cross-origin in the installed app, which serves these over static://:
    // without CORS the canvas is tainted and reading its pixels back throws.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => {
      console.warn(`[gobo] could not load ${file}`);
      resolve(null);
    };
    image.src = GOBO_URL + file;
  });
}

/**
 * The gobo atlas, built once. Returned at once with only the open pattern
 * in it; the OFL images load in the background and the texture is redrawn
 * when they are in, so nothing waits on them.
 *
 * @returns {THREE.CanvasTexture} one blur level per colour channel, 255 open
 */
export function goboTexture() {
  if (texture) return texture;
  canvas = document.createElement('canvas');
  canvas.width = GOBO_SIZE * GOBO_GRID;
  canvas.height = GOBO_SIZE * GOBO_GRID;
  pack(drawSharp([]));
  texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  Promise.all(GOBOS.map((g) => loadImage(g.file))).then((images) => {
    pack(drawSharp(images));
    texture.needsUpdate = true;
  });
  return texture;
}

/**
 * Which pattern a wheel slot shows.
 *
 * @param {Object} slot the OFL wheel slot, `{ type, resource }`
 * @param {Number} index the slot's position among the wheel's gobo slots
 * @returns {Number} a pattern index; 0 for an open or non-gobo slot
 */
export function goboLayerFor(slot, index) {
  if (!slot || slot.type !== 'Gobo') return 0;
  const resource = String(slot.resource || '').replace(/^gobos\//, '');
  const named = GOBOS.findIndex((g) => g.name === resource);
  if (named >= 0) return named + 1;
  return (index % GOBOS.length) + 1;
}
