// Originally after Fyrestar's THREE.InfiniteGridHelper
// (https://github.com/Fyrestar/THREE.InfiniteGridHelper). The plane that
// follows the camera is his; the shading is not.
import * as THREE from 'three';

/**
 * @file The ground grid, drawn at whatever scale can actually be read.
 *
 * The original drew two fixed decades at full strength all the way to the
 * horizon. That is fine directly under the camera and wrong everywhere else:
 * once a cell falls below a pixel the lines interfere with the pixel grid and
 * the floor turns into moire, which is worse than no grid at all -- and it was
 * bright white while doing it.
 *
 * So each decade is faded by how big its cells are **on screen** rather than by
 * how far away they are. A level appears once its cells are a few pixels
 * across and is gone before they can alias, which means the fine lines show up
 * when you lean in and the coarse ones carry the far distance, with no setting
 * to choose and nothing to switch. Three decades are drawn -- a tenth of the
 * unit, the unit, and ten of them -- so at any zoom two of them are visible and
 * the third is fading. Blender does the same thing for the same reason.
 *
 * Taken with `max` rather than added: where decades coincide -- and every tenth
 * line is in all three -- summing lights the crossings into a brighter lattice,
 * which is exactly the pattern the eye latches onto.
 */

/**
 * Cell size in pixels at which a decade starts and finishes fading in.
 *
 * The lower bound is what keeps moire away: below a handful of pixels a grid
 * cannot be drawn without interfering with the pixels drawing it, so it is not
 * drawn at all.
 */
const FADE_IN_PX = 6.0;
const FADE_FULL_PX = 40.0;

/**
 * A number as GLSL will read it as a float.
 *
 * `${6.0}` is the string "6", which GLSL takes for an int -- and an int where a
 * float belongs is a compile error or a silent conversion depending on the
 * driver. Every constant interpolated into a shader goes through this.
 *
 * @param {Number} value
 * @returns {String}
 */
const glslFloat = (value) => (Number.isInteger(value) ? `${value}.0` : `${value}`);

/** How strongly each decade draws, faintest first. */
const FINE_WEIGHT = 0.28;
const UNIT_WEIGHT = 0.55;
const COARSE_WEIGHT = 0.8;

/** Overall subtlety. The grid is a reference, not a subject. */
const DEFAULT_OPACITY = 0.4;

/**
 * How wide a line is drawn, in pixels.
 *
 * Kept in step with the `gridLineWidth` preference, which is what actually
 * drives it in the app -- this is only what the grid draws with before the
 * stored value reaches it, and a mismatch shows up as a flicker on load.
 *
 * Below 1 it stops being a width and becomes an opacity, because a line
 * narrower than a pixel cannot be drawn -- the fragment either samples it or
 * it does not, and asking for half a pixel of geometry is how a grid starts to
 * crawl as the camera moves. So under a pixel the falloff stays at one and the
 * coverage is scaled instead, which is what a half-covered pixel should look
 * like anyway.
 */
const DEFAULT_LINE_WIDTH_PX = 0.3;

/** A cool grey that reads against both the light and the dark venue. */
const DEFAULT_COLOR = '#7d858e';

class InfiniteGridHelper extends THREE.Mesh {
  /**
   * @param {Number} unit metres between the main lines -- the user's spacing
   * @param {THREE.Color} [color]
   * @param {Number} [distance] how far the ground plane reaches, in metres
   * @param {String} [axes] which two axes the plane lies in
   */
  constructor(unit = 1, color = null, distance = 100, axes = 'xzy') {
    const planeAxes = axes.substr(0, 2);
    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);

    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      // A reference layer: it must not stop anything drawn after it, and it
      // has no depth of its own worth keeping.
      depthWrite: false,
      // Its colour is chosen to be unobtrusive, so tone mapping must not go
      // and make it something else.
      toneMapped: false,
      uniforms: {
        uUnit: { value: unit > 0 ? unit : 1 },
        uColor: { value: color || new THREE.Color(DEFAULT_COLOR) },
        uDistance: { value: distance },
        uOpacity: { value: DEFAULT_OPACITY },
        uLineWidth: { value: DEFAULT_LINE_WIDTH_PX },
      },
      vertexShader: /* glsl */`
        varying vec3 worldPosition;
        uniform float uDistance;

        void main() {
          // The plane is carried along under the camera, so it never runs out.
          vec3 pos = position.${axes} * uDistance;
          pos.${planeAxes} += cameraPosition.${planeAxes};
          worldPosition = pos;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 worldPosition;

        uniform float uUnit;
        uniform vec3 uColor;
        uniform float uDistance;
        uniform float uOpacity;
        uniform float uLineWidth;

        /** Antialiased coverage of the lines of a grid of this cell size. */
        float gridCoverage(float size) {
          vec2 r = worldPosition.${planeAxes} / size;

          // How far a pixel steps along each grid axis, measured properly.
          //
          // fwidth() is the obvious thing to use here and is what this did.
          // It returns about |dFdx| + |dFdy|, which is the right order of
          // magnitude and up to twice too large on a diagonal -- so lines grew
          // and shrank with their angle to the screen, and the whole grid read
          // soft and uneven next to one drawn properly. The true rate of
          // change of each axis across the screen is the length of its
          // gradient, so that is what is taken.
          vec2 ddx = dFdx(r);
          vec2 ddy = dFdy(r);
          vec2 gradient = vec2(
            length(vec2(ddx.x, ddy.x)),
            length(vec2(ddx.y, ddy.y))
          );

          // Distance to the nearest line of this grid, in pixels.
          vec2 d = abs(fract(r - 0.5) - 0.5) / max(gradient, vec2(1e-6));
          float pixels = min(d.x, d.y);
          float width = max(uLineWidth, 0.02);
          // At or above a pixel the width is a real width. Below one it cannot
          // be -- so the falloff stays at a pixel and the coverage carries the
          // rest, which is a fainter line rather than a flickering one.
          float line = 1.0 - min(pixels / max(width, 1.0), 1.0);
          return line * min(width, 1.0);
        }

        /** Roughly how many pixels across one cell of this size is. */
        float cellPixels(float size) {
          vec2 w = fwidth(worldPosition.${planeAxes});
          return size / max(max(w.x, w.y), 1e-6);
        }

        /** A decade's weight: absent while its cells are too small to read. */
        float levelFade(float size) {
          return smoothstep(${glslFloat(FADE_IN_PX)}, ${glslFloat(FADE_FULL_PX)}, cellPixels(size));
        }

        void main() {
          float unit = max(uUnit, 1e-4);

          // Taken as a maximum, not a sum: every tenth line belongs to more
          // than one decade, and adding them draws a brighter lattice over the
          // top -- which is the pattern that makes a grid tiring to look at.
          float a = gridCoverage(unit * 0.1) * levelFade(unit * 0.1) * ${glslFloat(FINE_WEIGHT)};
          a = max(a, gridCoverage(unit) * levelFade(unit) * ${glslFloat(UNIT_WEIGHT)});
          a = max(a, gridCoverage(unit * 10.0) * levelFade(unit * 10.0) * ${glslFloat(COARSE_WEIGHT)});

          // Gone before the plane's own edge, so the grid ends in nothing
          // rather than in a visible rim.
          float d = distance(cameraPosition.${planeAxes}, worldPosition.${planeAxes});
          a *= 1.0 - smoothstep(uDistance * 0.35, uDistance * 0.95, d);

          a *= uOpacity;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });

    super(geometry, material);
    this.frustumCulled = false;
  }

  /**
   * Re-spaces the grid.
   *
   * One number, because the rest follow from it: a tenth of it and ten of it
   * are drawn too, and which of the three you can see is decided by the zoom
   * rather than by a setting.
   *
   * @public
   * @param {Number} spacing metres between the main lines
   */
  setSpacing(spacing) {
    const unit = Number(spacing) > 0 ? Number(spacing) : 1;
    this.material.uniforms.uUnit.value = unit;
  }

  /**
   * How strongly the grid draws overall.
   *
   * @public
   * @type {Number}
   */
  set opacity(value) {
    const wanted = Number(value);
    if (Number.isFinite(wanted)) this.material.uniforms.uOpacity.value = wanted;
  }

  get opacity() {
    return this.material.uniforms.uOpacity.value;
  }

  /**
   * How wide the lines are drawn, in pixels. Under 1 they get fainter rather
   * than narrower -- see `DEFAULT_LINE_WIDTH_PX`.
   *
   * @public
   * @type {Number}
   */
  set lineWidth(value) {
    const wanted = Number(value);
    if (Number.isFinite(wanted) && wanted > 0) {
      this.material.uniforms.uLineWidth.value = wanted;
    }
  }

  get lineWidth() {
    return this.material.uniforms.uLineWidth.value;
  }
}

export default InfiniteGridHelper;
