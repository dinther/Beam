import * as THREE from 'three';

/**
 * @file Navigation gizmo for the viewport corner, laid out as Blender's: a
 * ball on each axis, the positive three labelled and joined to the centre,
 * the negative three plain until hovered. Click a ball to look along that
 * axis, click the ball already facing you to look from the other side, drag
 * to orbit.
 *
 * Drawn in 2D on a canvas of its own, pinned to the panel's top-right corner,
 * so it is never in a recording and stays put when studio mode letterboxes
 * the scene canvas.
 */

/** Side of the gizmo's square, in pixels. */
const DIM = 90;
/** How far the gizmo is held off the corner, in pixels. */
const MARGIN = 14;
/** Extra drop below the header, in pixels, so it clears the Debug panel's bar. */
const TOP_DROP = 20;
/** How far a press may travel and still be a click on a ball, in pixels. */
const CLICK_SLOP_PX = 4;
/** Ball radius, in pixels. */
const BALL_R = 9;
/** Centre to ball centre, in pixels. */
const ARM = DIM / 2 - BALL_R - 3;
/** A view counts as along an axis when its direction is this close to it. */
const ALIGNED_DOT = 0.9999;

const STYLE = {
  label: '#1c2126',
  hoverLabel: '#ffffff',
  backdrop: 'rgba(233, 237, 242, 0.08)',
  font: 'bold 10px Roboto-Bold, sans-serif',
};

/** The axis colours the transform gizmo and the measure tool use. */
const AXIS_COLOURS = {
  x: { rgb: [229, 72, 77] },
  y: { rgb: [70, 167, 88] },
  z: { rgb: [62, 142, 208] },
};
Object.values(AXIS_COLOURS).forEach((c) => {
  const [r, g, b] = c.rgb;
  const mix = (t) => c.rgb.map((v) => Math.round(v + (255 - v) * t)).join(', ');
  Object.assign(c, {
    full: `rgb(${r}, ${g}, ${b})`,
    // Negative balls are a dark tint with a rim in the axis colour.
    dark: `rgba(${r}, ${g}, ${b}, 0.3)`,
    // Hovered: lighter, so it reads as lit rather than recoloured.
    light: `rgb(${mix(0.45)})`,
  });
});

/**
 * The six balls: the axis they sit on, its label, its colour, and the named
 * view looking from that side. Z is up.
 *
 * @constant {Array}
 */
const BALLS = [
  {
    dir: [1, 0, 0], label: 'X', colour: AXIS_COLOURS.x, view: 'right',
  },
  {
    dir: [0, 1, 0], label: 'Y', colour: AXIS_COLOURS.y, view: 'back',
  },
  {
    dir: [0, 0, 1], label: 'Z', colour: AXIS_COLOURS.z, view: 'top',
  },
  {
    dir: [-1, 0, 0], label: '-X', colour: AXIS_COLOURS.x, view: 'left',
  },
  {
    dir: [0, -1, 0], label: '-Y', colour: AXIS_COLOURS.y, view: 'front',
  },
  {
    dir: [0, 0, -1], label: '-Z', colour: AXIS_COLOURS.z, view: 'bottom',
  },
].map((ball, index) => ({
  ...ball,
  index,
  positive: index < 3,
  axis: new THREE.Vector3(...ball.dir),
  opposite: (index + 3) % 6,
}));

const inverse = new THREE.Quaternion();
const projected = new THREE.Vector3();
const looking = new THREE.Vector3();

class NavGizmo {
  /**
   * @param {Object} camera the scene camera the gizmo reflects
   * @param {Object} domElement the scene canvas, whose panel holds the gizmo
   * @param {Object} handlers `{ pick({ view }), orbit(dx, dy) }`: a click on
   *   a ball, and a drag in pixels
   */
  constructor(camera, domElement, handlers = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.handlers = handlers;
    /** Index of the ball under the pointer, or -1. */
    this.hovered = -1;
    /** Whether the pointer is over the gizmo's square. */
    this.inside = false;
    /** Ball positions on screen from the last draw, front first. */
    this.placed = [];
    this.lastKey = '';
    this.mountCanvas();
  }

  /**
   * Where each ball is drawn for the camera's current turn.
   *
   * @private
   * @returns {Array} `{ ball, x, y, depth }`, back to front
   */
  layout() {
    inverse.copy(this.camera.quaternion).invert();
    const c = DIM / 2;
    return BALLS.map((ball) => {
      projected.copy(ball.axis).applyQuaternion(inverse);
      return {
        ball, x: c + projected.x * ARM, y: c - projected.y * ARM, depth: projected.z,
      };
    }).sort((a, b) => a.depth - b.depth);
  }

  /**
   * Draws the gizmo when the camera or the hover has changed.
   *
   * @public
   */
  render() {
    this.place();
    if (this.canvas.style.display === 'none') return;
    const q = this.camera.quaternion;
    const key = `${q.x.toFixed(5)},${q.y.toFixed(5)},${q.z.toFixed(5)},${q.w.toFixed(5)},${this.hovered},${this.inside}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const { context: ctx, ratio } = this;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, DIM, DIM);
    const c = DIM / 2;
    if (this.inside) {
      ctx.fillStyle = STYLE.backdrop;
      ctx.beginPath();
      ctx.arc(c, c, DIM / 2 - 1, 0, Math.PI * 2);
      ctx.fill();
    }

    const placed = this.layout();
    ctx.font = STYLE.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    placed.forEach(({ ball, x, y }) => {
      const lit = ball.index === this.hovered;
      const { colour } = ball;
      if (ball.positive) {
        ctx.strokeStyle = colour.full;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, ball.positive ? BALL_R : BALL_R - 1, 0, Math.PI * 2);
      if (ball.positive || lit) {
        ctx.fillStyle = lit ? colour.light : colour.full;
        ctx.fill();
      } else {
        ctx.fillStyle = colour.dark;
        ctx.fill();
        ctx.strokeStyle = colour.full;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (ball.positive || lit) {
        ctx.fillStyle = lit ? STYLE.hoverLabel : STYLE.label;
        ctx.fillText(ball.label, x, y + 0.5);
      }
    });
    this.placed = placed.reverse();
  }

  /**
   * The ball under a pointer event, front first.
   *
   * @private
   * @param {Object} event pointer event
   * @returns {Object|null} the ball
   */
  pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / (rect.width || 1)) * DIM;
    const y = ((event.clientY - rect.top) / (rect.height || 1)) * DIM;
    const hit = this.placed.find((p) => Math.hypot(p.x - x, p.y - y) <= BALL_R + 1);
    return hit ? hit.ball : null;
  }

  /**
   * The view a click on a ball gives: along its axis, or from the other side
   * when the view is already along it.
   *
   * @private
   * @param {Object} ball
   * @returns {String} a named view
   */
  viewFor(ball) {
    looking.set(0, 0, 1).applyQuaternion(this.camera.quaternion);
    return looking.dot(ball.axis) > ALIGNED_DOT ? BALLS[ball.opposite].view : ball.view;
  }

  /**
   * Drops any highlight, for when the pointer leaves.
   *
   * @public
   */
  clearHover() {
    this.hovered = -1;
    this.inside = false;
  }

  /**
   * Creates the gizmo's canvas in the scene canvas's panel.
   *
   * @private
   */
  mountCanvas() {
    this.canvas = document.createElement('canvas');
    this.ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(DIM * this.ratio);
    this.canvas.height = Math.round(DIM * this.ratio);
    Object.assign(this.canvas.style, {
      position: 'absolute',
      width: `${DIM}px`,
      height: `${DIM}px`,
      right: `${MARGIN}px`,
      zIndex: 2,
      cursor: 'grab',
    });
    const panel = this.domElement.parentElement;
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    panel.appendChild(this.canvas);
    this.context = this.canvas.getContext('2d');

    this.downAt = null;
    this.dragged = false;
    this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.downAt) this.clearHover();
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.downAt = { x: event.clientX, y: event.clientY };
      this.lastAt = { x: event.clientX, y: event.clientY };
      this.dragged = false;
    });
    this.canvas.addEventListener('pointerup', (event) => {
      const down = this.downAt;
      this.downAt = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.canvas.style.cursor = this.hovered >= 0 ? 'pointer' : 'grab';
      if (!down || this.dragged) return;
      const ball = this.pick(event);
      if (ball && this.handlers.pick) this.handlers.pick({ view: this.viewFor(ball) });
    });
  }

  /**
   * Hovers, or, with the button held, turns the view as dragging the scene
   * does.
   *
   * @private
   * @param {Object} event pointer event
   */
  onPointerMove(event) {
    if (!this.downAt) {
      this.inside = true;
      const ball = this.pick(event);
      this.hovered = ball ? ball.index : -1;
      this.canvas.style.cursor = ball ? 'pointer' : 'grab';
      return;
    }
    const travelled = Math.hypot(event.clientX - this.downAt.x, event.clientY - this.downAt.y);
    if (travelled > CLICK_SLOP_PX) {
      this.dragged = true;
      this.canvas.style.cursor = 'grabbing';
    }
    if (!this.dragged) return;
    const dx = event.clientX - this.lastAt.x;
    const dy = event.clientY - this.lastAt.y;
    this.lastAt = { x: event.clientX, y: event.clientY };
    if (this.handlers.orbit) this.handlers.orbit(dx, dy);
  }

  /**
   * Keeps the canvas at the top-right of the panel, just under its header,
   * and hidden with the scene canvas.
   *
   * @private
   */
  place() {
    const shown = this.domElement.offsetWidth > 0 && this.domElement.offsetHeight > 0;
    const display = shown ? '' : 'none';
    if (this.canvas.style.display !== display) this.canvas.style.display = display;
    if (!shown) return;
    const header = this.domElement.previousElementSibling;
    const top = (header ? header.offsetTop + header.offsetHeight : 0) + MARGIN + TOP_DROP;
    const css = `${top}px`;
    if (this.canvas.style.top !== css) this.canvas.style.top = css;
  }

  /**
   * Removes the canvas.
   *
   * @public
   */
  dispose() {
    this.canvas.remove();
  }
}

export default NavGizmo;
