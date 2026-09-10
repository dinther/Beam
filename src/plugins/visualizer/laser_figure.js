import * as THREE from 'three';

/**
 * @file What a laser is drawing, as a picture, ready to be thrown onto geometry.
 *
 * The beam in the air is geometry -- a fan of triangles from the aperture. That
 * answers "what does the light look like in the haze", but not "what does the
 * figure look like where it lands". A line painted across a wall is a picture,
 * and the cheapest way to put a picture on arbitrary geometry is to project it,
 * exactly as `projector_pass` does for a video projector.
 *
 * So each laser rasterises its own point stream into a tile here, in the flat
 * space its aperture camera projects from, and the pass that comes later reads
 * this tile per fragment. Tiled into one texture for the same reason the depth
 * atlas is: one texture unit however many lasers are in the rig.
 *
 * **The figure is projected, not derived.** Where a point belongs in this tile
 * is exactly where its own beam lands, so rather than reasoning about the
 * mapping, each beam's far point is pushed through the very matrix the surface
 * pass will later read this tile with. That gets the tangent curve right (a
 * galvo deflects by angle, a perspective camera places by tangent) and the
 * handedness right (the aperture camera's right axis runs along world -X, so a
 * beam going +X lands on the *left* of the tile) without either having to be
 * written down anywhere to be got wrong -- which is exactly how the first
 * attempt ended up painting the figure mirrored against its own beams.
 *
 * Unlike the depth atlas this is redrawn every frame and never cached: the
 * whole point of it is content that changes.
 */

/**
 * Tiles across and down, and the size of one. Sixteen lasers, one texture.
 *
 * A tile spans the whole scan field, so its resolution is an angle: at 512 one
 * texel is about a tenth of a degree, three centimetres on a wall twenty
 * metres away, which reads as visible blocks up close. 1024 halves that.
 * The atlas costs 4096 x 4096 x RGBA8 -- 64 MB, which is nothing against what
 * it buys, and it does not grow with the number of lasers.
 */
const COLUMNS = 4;
const ROWS = 4;
const TILE = 1024;

/**
 * How wide a stroke is drawn, in tile pixels.
 *
 * A real beam is a fraction of a degree across, which at this tile size is well
 * under a pixel -- drawn honestly it would alias into dashes and disappear at
 * distance. Drawn several pixels wide with a soft edge it survives being
 * magnified across a wall, which is what this texture is for. Seven is what
 * reads right on a facade at twenty-odd metres.
 */
let linePixels = 7;

/**
 * How wide a stroke is drawn, in tile pixels. Tunable from the debug panel.
 *
 * @public
 * @param {Number} px
 */
export function setLineWidth(px) {
  linePixels = Math.min(Math.max(Number(px) || 0, 0.5), 16);
}

/** @public @returns {Number} the current stroke width in tile pixels */
export function lineWidth() {
  return linePixels;
}

/** Tile pixels to the -1..1 the tile spans. */
const PIXEL = 2 / TILE;

/** Scratch for placing a point, so a frame's rebuild allocates nothing. */
const projected = new THREE.Vector3();

/** Vertices per stroke: two triangles. */
const VERTS_PER_QUAD = 6;

/**
 * Soft-edged, additive, and blind to depth.
 *
 * Additive because two strokes crossing are brighter where they cross, which is
 * true of light and is the whole reason a figure reads. Depth off because this
 * is a flat picture, not a scene.
 */
function makeFigureMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 acolor;
      attribute vec2 aUv;
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        vColor = acolor;
        vUv = aUv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vColor;
      varying vec2 vUv;
      void main() {
        // x runs across the stroke, y is zero along its length and only opens
        // up for a lone point, so a line falls off sideways and a dot falls off
        // in every direction from one branch of maths.
        float r2 = dot(vUv, vUv);
        float a = exp(-3.0 * r2);
        gl_FragColor = vec4(vColor * a, a);
      }
    `,
  });
}

/**
 * One laser's picture: the geometry, and the buffers behind it.
 *
 * Owned by the laser, filled from the same per-point arrays its beam is built
 * from, and drawn into that laser's tile once a frame.
 */
export class LaserFigure {
  /** @param {Number} maxPoints the most points a frame will carry */
  constructor(maxPoints) {
    this.capacity = maxPoints * VERTS_PER_QUAD;
    this._pos = new Float32Array(this.capacity * 3);
    this._col = new Float32Array(this.capacity * 3);
    this._uv = new Float32Array(this.capacity * 2);

    const dyn = (arr, size) => new THREE.BufferAttribute(arr, size)
      .setUsage(THREE.DynamicDrawUsage);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', dyn(this._pos, 3));
    this.geometry.setAttribute('acolor', dyn(this._col, 3));
    this.geometry.setAttribute('aUv', dyn(this._uv, 2));
    this.geometry.setDrawRange(0, 0);
    // Never culled: the geometry is rewritten every frame and lives in a flat
    // -1..1 space that a bounding sphere computed once would not describe.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

    this.mesh = new THREE.Mesh(this.geometry, makeFigureMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.count = 0;
    this._seen = new Uint8Array(maxPoints);
    this._px = new Float32Array(maxPoints);
    this._py = new Float32Array(maxPoints);
  }

  /**
   * Rasterises a frame's points into strokes.
   *
   * Takes the arrays the beam was built from rather than the raw stream, so the
   * two are the same figure by construction: the same lit test, the same jump
   * guard, the same colours, the same normalised positions.
   *
   * @public
   * @param {Object} f the frame: counts, the per-point arrays, and the angles
   */
  build(f) {
    const {
      n, far, col, lit, linked, clip,
    } = f;
    const pos = this._pos;
    const colour = this._col;
    const uv = this._uv;
    const half = linePixels * PIXEL * 0.5;
    let v = 0;

    // Where each point's own beam lands, in this tile's coordinates. Projected
    // through the pass's own matrix rather than reasoned about, so the picture
    // and the beams cannot be mirrored or warped apart from one another.
    const seen = this._seen;
    const px = this._px;
    const py = this._py;
    for (let i = 0; i < n; i += 1) {
      seen[i] = 0;
      if (lit[i]) {
        const i3 = i * 3;
        projected.set(far[i3], far[i3 + 1], far[i3 + 2]).applyMatrix4(clip);
        if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
          seen[i] = 1;
          px[i] = projected.x;
          py[i] = projected.y;
        }
      }
    }

    const put = (x, y, r, g, b, u0, u1) => {
      if (v >= this.capacity) return;
      const p3 = v * 3;
      pos[p3] = x; pos[p3 + 1] = y; pos[p3 + 2] = 0;
      colour[p3] = r; colour[p3 + 1] = g; colour[p3 + 2] = b;
      uv[v * 2] = u0; uv[v * 2 + 1] = u1;
      v += 1;
    };

    // A held point, or one standing alone between blanked travel: a round dot,
    // which is what a stationary beam actually leaves on a surface.
    const dot = (x, y, c3) => {
      const r = col[c3]; const g = col[c3 + 1]; const b = col[c3 + 2];
      put(x - half, y - half, r, g, b, -1, -1);
      put(x + half, y - half, r, g, b, 1, -1);
      put(x + half, y + half, r, g, b, 1, 1);
      put(x - half, y - half, r, g, b, -1, -1);
      put(x + half, y + half, r, g, b, 1, 1);
      put(x - half, y + half, r, g, b, -1, 1);
    };

    // A stroke: the quad swept between two points that belong to one line.
    const stroke = (ax, ay, bx, by, c3) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      // Two points a scanner's sample apart land almost on top of each other,
      // and a direction taken from that difference is mostly rounding error,
      // turning every little quad a slightly different way and breaking the
      // line into beads. Too short to have a direction, draw the dot.
      if (len < half * 0.25) {
        dot(ax, ay, c3);
        return;
      }
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy * half;
      const ny = ux * half;
      // Capped by half a width at each end, so consecutive strokes overlap at
      // the joins instead of leaving a gap between them.
      const sx = ax - ux * half;
      const sy = ay - uy * half;
      const ex = bx + ux * half;
      const ey = by + uy * half;
      const r = col[c3]; const g = col[c3 + 1]; const b = col[c3 + 2];
      put(sx + nx, sy + ny, r, g, b, 1, 0);
      put(sx - nx, sy - ny, r, g, b, -1, 0);
      put(ex - nx, ey - ny, r, g, b, -1, 0);
      put(sx + nx, sy + ny, r, g, b, 1, 0);
      put(ex - nx, ey - ny, r, g, b, -1, 0);
      put(ex + nx, ey + ny, r, g, b, 1, 0);
    };

    for (let i = 0; i + 1 < n; i += 1) {
      if (seen[i] && seen[i + 1] && linked[i] && linked[i + 1]) {
        stroke(px[i], py[i], px[i + 1], py[i + 1], i * 3);
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (seen[i] && !linked[i]) {
        dot(px[i], py[i], i * 3);
      }
    }

    this.count = v;
    this.geometry.setDrawRange(0, v);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.acolor.needsUpdate = true;
    this.geometry.attributes.aUv.needsUpdate = true;
  }

  /** @public Releases the geometry and material. */
  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Scratch, so a per-frame pass allocates nothing. */
const previousColour = new THREE.Color();
const scratchSize = new THREE.Vector2();

/**
 * Every laser's picture, tiled into one texture.
 */
class FigureAtlas {
  constructor() {
    this.columns = COLUMNS;
    this.rows = ROWS;
    this.tile = TILE;
    this.maxTiles = COLUMNS * ROWS;
    this.target = null;
    // A flat -1..1 sheet seen square on, which is what a tile is.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    // Its own scene, holding nothing but figures. No background is set, so
    // nothing clear-blits over the tiles -- the mistake that cost the depth
    // atlas a day.
    this.scene = new THREE.Scene();
    this.scene.background = null;
  }

  ensureTarget() {
    if (this.target) return this.target;
    this.target = new THREE.WebGLRenderTarget(COLUMNS * TILE, ROWS * TILE, {
      // Filtered, unlike depth: this one is a picture, and it gets magnified
      // across a wall.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
    });
    return this.target;
  }

  /**
   * Where a slot sits in the atlas, in texture coordinates.
   *
   * @public
   * @param {Number} slot
   * @returns {Object} `{ x, y, width, height }`
   */
  // eslint-disable-next-line class-methods-use-this
  tileUv(slot) {
    return {
      x: (slot % COLUMNS) / COLUMNS,
      y: Math.floor(slot / COLUMNS) / ROWS,
      width: 1 / COLUMNS,
      height: 1 / ROWS,
    };
  }

  /** @public @returns {Object|null} the atlas texture, once one has been drawn */
  texture() {
    return this.target ? this.target.texture : null;
  }

  /** @public Adds a figure's mesh to the atlas scene. */
  attach(figure) {
    this.scene.add(figure.mesh);
  }

  /** @public Removes a figure's mesh again. */
  detach(figure) {
    this.scene.remove(figure.mesh);
  }

  /**
   * Draws each laser's picture into its own tile.
   *
   * @public
   * @param {Object} renderer THREE.WebGLRenderer
   * @param {Array} entries each `{ slot, figure }`, in slot order
   */
  render(renderer, entries) {
    if (!entries || !entries.length) return;
    this.ensureTarget();

    const wasTarget = renderer.getRenderTarget();
    const wasAutoClear = renderer.autoClear;
    const wasAlpha = renderer.getClearAlpha();
    renderer.getClearColor(previousColour);

    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.setScissorTest(false);
      // Unlit is black: nothing drawn means no light landing.
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      renderer.setScissorTest(true);

      entries.forEach(({ slot, figure }) => {
        if (slot < 0 || slot >= this.maxTiles || !figure.count) return;
        const x = (slot % COLUMNS) * TILE;
        const y = Math.floor(slot / COLUMNS) * TILE;
        renderer.setViewport(x, y, TILE, TILE);
        renderer.setScissor(x, y, TILE, TILE);
        figure.mesh.visible = true;
        renderer.render(this.scene, this.camera);
        figure.mesh.visible = false;
      });
    } finally {
      entries.forEach(({ figure }) => { figure.mesh.visible = false; });
      renderer.setScissorTest(false);
      renderer.setRenderTarget(wasTarget);
      renderer.setClearColor(previousColour, wasAlpha);
      renderer.autoClear = wasAutoClear;
      renderer.getSize(scratchSize);
      renderer.setViewport(0, 0, scratchSize.x, scratchSize.y);
    }
  }
}

export default new FigureAtlas();
