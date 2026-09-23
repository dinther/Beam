import * as THREE from 'three';

/**
 * @file The gobo patterns every beam can project, in one atlas texture.
 *
 * A gobo is a stencil in the beam: white where light passes, black where it
 * is blocked. Fixture profiles name their gobos by an OFL resource such as
 * `gobos/10-circles`, but no image library ships with the profiles, so the
 * patterns are drawn here procedurally, once, into the cells of one atlas
 * texture. Any beam then reads its gobo by pattern index, in the air and on
 * the surfaces it lands on, from the same texture.
 *
 * A profile that names a resource gets the pattern of the same name when one
 * exists here and a stand-in otherwise; a profile that names nothing, which
 * is most of them, gets patterns by slot order, so every gobo wheel shows
 * something different in each slot.
 *
 * Pattern 0 is fully open and is what an open slot or a fixture without a
 * gobo wheel reads, so the shaders never read the atlas for it.
 */

/** Pixels across one pattern. Mipmapped, so the beam reads a blurred level far out. */
const GOBO_SIZE = 256;

/** A filled white circle in field units. */
function disc(c, x, y, r) {
  c.fillStyle = '#fff';
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

function ring(c, count, radius, size, phase = 0) {
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + phase;
    disc(c, 0.5 + radius * Math.cos(a), 0.5 + radius * Math.sin(a), size);
  }
}

function polygon(c, x, y, r, sides, phase) {
  c.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2 + phase;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
}

/**
 * The drawing of each pattern, on a canvas context whose unit square is the
 * field of the beam: (0, 0) top-left, (1, 1) bottom-right, the aperture
 * circle inscribed. White passes light; the canvas starts black.
 *
 * Named after the OFL resources the shipped profiles reference where a
 * pattern stands in for one, so that `layerFor` can match them.
 */
const PATTERNS = [
  { name: 'open', draw: (c) => { c.fillStyle = '#fff'; c.fillRect(0, 0, 1, 1); } },
  {
    name: '10-circles',
    draw: (c) => {
      ring(c, 5, 0.3, 0.09);
      ring(c, 5, 0.18, 0.055, Math.PI / 5);
    },
  },
  {
    name: 'dot-spiral',
    draw: (c) => {
      for (let i = 0; i < 24; i += 1) {
        const t = i / 24;
        const a = t * Math.PI * 4;
        const r = 0.05 + t * 0.4;
        disc(c, 0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 0.02 + t * 0.035);
      }
    },
  },
  {
    name: 'triangle-hexagon-pattern',
    draw: (c) => {
      c.fillStyle = '#fff';
      for (let row = -3; row <= 3; row += 1) {
        for (let col = -3; col <= 3; col += 1) {
          const x = 0.5 + col * 0.16 + (row % 2 ? 0.08 : 0);
          const y = 0.5 + row * 0.14;
          polygon(c, x, y, 0.05, 3, (row + col) % 2 ? Math.PI : 0);
        }
      }
    },
  },
  {
    name: 'rose-petal',
    draw: (c) => {
      c.fillStyle = '#fff';
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        c.save();
        c.translate(0.5, 0.5);
        c.rotate(a);
        c.beginPath();
        c.ellipse(0.24, 0, 0.2, 0.075, 0, 0, Math.PI * 2);
        c.fill();
        c.restore();
      }
      c.fillStyle = '#000';
      c.beginPath();
      c.arc(0.5, 0.5, 0.07, 0, Math.PI * 2);
      c.fill();
    },
  },
  {
    name: '3-fold-swirl',
    draw: (c) => {
      c.strokeStyle = '#fff';
      c.lineWidth = 0.05;
      c.lineCap = 'round';
      for (let arm = 0; arm < 3; arm += 1) {
        c.beginPath();
        for (let i = 0; i <= 40; i += 1) {
          const t = i / 40;
          const a = (arm / 3) * Math.PI * 2 + t * Math.PI * 1.4;
          const r = 0.04 + t * 0.4;
          const x = 0.5 + r * Math.cos(a);
          const y = 0.5 + r * Math.sin(a);
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
    },
  },
  {
    name: 'glass-raindrops-on-window',
    draw: (c) => {
      let seed = 7;
      const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < 60; i += 1) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * 0.44;
        disc(c, 0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), 0.012 + rand() * 0.035);
      }
    },
  },
  {
    name: 'biohazard',
    draw: (c) => {
      c.fillStyle = '#fff';
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        c.beginPath();
        c.arc(0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), 0.19, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#000';
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        c.beginPath();
        c.arc(0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a), 0.1, 0, Math.PI * 2);
        c.fill();
      }
      c.beginPath();
      c.arc(0.5, 0.5, 0.12, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#fff';
      c.beginPath();
      c.arc(0.5, 0.5, 0.05, 0, Math.PI * 2);
      c.fill();
    },
  },
  {
    name: 'breakup',
    draw: (c) => {
      let seed = 3;
      const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
      c.fillStyle = '#fff';
      for (let i = 0; i < 26; i += 1) {
        const a = rand() * Math.PI * 2;
        const r = Math.sqrt(rand()) * 0.42;
        polygon(
          c,
          0.5 + r * Math.cos(a),
          0.5 + r * Math.sin(a),
          0.04 + rand() * 0.07,
          3 + Math.floor(rand() * 4),
          rand() * Math.PI,
        );
      }
    },
  },
  {
    name: 'star',
    draw: (c) => {
      c.fillStyle = '#fff';
      c.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 ? 0.18 : 0.44;
        const x = 0.5 + r * Math.cos(a);
        const y = 0.5 + r * Math.sin(a);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.closePath();
      c.fill();
    },
  },
  {
    name: 'lines',
    draw: (c) => {
      c.fillStyle = '#fff';
      for (let i = -4; i <= 4; i += 1) {
        c.fillRect(0.5 + i * 0.11 - 0.025, 0, 0.05, 1);
      }
    },
  },
  {
    name: 'rings',
    draw: (c) => {
      c.strokeStyle = '#fff';
      c.lineWidth = 0.04;
      for (let i = 1; i <= 4; i += 1) {
        c.beginPath();
        c.arc(0.5, 0.5, i * 0.1, 0, Math.PI * 2);
        c.stroke();
      }
    },
  },
  {
    name: 'cross',
    draw: (c) => {
      c.fillStyle = '#fff';
      c.fillRect(0.44, 0.05, 0.12, 0.9);
      c.fillRect(0.05, 0.44, 0.9, 0.12);
    },
  },
];

/** Patterns a slot without a named resource cycles through, open excluded. */
const STAND_INS = PATTERNS.map((p, i) => i).filter((i) => i > 0);

/** Patterns across and down one level of the atlas; 16 cells for the patterns above. */
export const GOBO_GRID = 4;

/**
 * The blur each level of the atlas is baked with, as a Gaussian's sigma in
 * the pattern's pixels: level 0 is sharp, the last is a gobo with the focus
 * wound fully out. Baked once, on the CPU, with the canvas's own blur, so a
 * defocused gobo is a true smooth blur: blurring in the shader either showed
 * a coarse mip's texels as blocks or, as a disc of taps, smeared copies.
 *
 * Three, because a stencil is one grey value and the atlas's pixels have
 * three colour channels: level i lives in channel i, so every level shares
 * one square 1024 px image and one read returns them all.
 */
const GOBO_BLUR_SIGMAS = [0, 5, 14];

/** How many blur levels the atlas holds, one per colour channel. */
export const GOBO_BLUR_LEVELS = GOBO_BLUR_SIGMAS.length;

let texture = null;

/**
 * Draws every pattern into one atlas, once: a grid of GOBO_GRID cells across
 * and down, each GOBO_SIZE pixels, pattern i in cell i row-major; red holds
 * the sharp pattern, green and blue the blurred ones. A plain canvas
 * texture with mipmaps, which is the texture path everything else in Beam
 * relies on.
 *
 * @returns {THREE.CanvasTexture} one blur level per colour channel, 255 open
 */
export function goboTexture() {
  if (texture) return texture;
  const size = GOBO_SIZE * GOBO_GRID;
  const sharp = document.createElement('canvas');
  sharp.width = size;
  sharp.height = size;
  const s = sharp.getContext('2d');
  s.fillStyle = '#000';
  s.fillRect(0, 0, size, size);
  PATTERNS.forEach((pattern, index) => {
    const column = index % GOBO_GRID;
    const row = Math.floor(index / GOBO_GRID);
    s.save();
    s.beginPath();
    s.rect(column * GOBO_SIZE, row * GOBO_SIZE, GOBO_SIZE, GOBO_SIZE);
    s.clip();
    s.setTransform(GOBO_SIZE, 0, 0, GOBO_SIZE, column * GOBO_SIZE, row * GOBO_SIZE);
    pattern.draw(s);
    s.restore();
  });

  const work = document.createElement('canvas');
  work.width = size;
  work.height = size;
  const w = work.getContext('2d');
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d');
  const packed = c.createImageData(size, size);
  GOBO_BLUR_SIGMAS.forEach((sigma, level) => {
    w.fillStyle = '#000';
    w.fillRect(0, 0, size, size);
    // Cell by cell, each clipped to itself, so a blur never pulls a
    // neighbouring pattern into this one.
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
    for (let i = 0; i < pixels.length; i += 4) packed.data[i + level] = pixels[i];
  });
  for (let i = 3; i < packed.data.length; i += 4) packed.data[i] = 255;
  c.putImageData(packed, 0, 0);

  texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
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
  const named = PATTERNS.findIndex((p) => p.name === resource);
  if (named > 0) return named;
  return STAND_INS[index % STAND_INS.length];
}
