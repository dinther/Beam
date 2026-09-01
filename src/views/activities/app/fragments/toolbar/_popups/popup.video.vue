<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    no-validation
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="8"
      col
    >
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Video</h3>
        <p class="subtitle">
          Carve the incoming frame into connectors. A device is patched to a
          connector rather than to a rectangle, so two devices can share one.
        </p>
      </uk-flex>

      <uk-flex :gap="12">
        <!-- The frame, with the rectangles over it. The canvas is drawn by a
             WebGL context of this popup's own -- see `mountPreview` -- because
             a texture belongs to the context that uploaded it. -->
        <div
          ref="stage"
          class="video_stage"
          @pointerdown="startDraw"
        >
          <canvas
            ref="canvas"
            class="video_canvas"
          />
          <p
            v-if="!hasPicture"
            class="video_stage_empty"
          >
            {{ status }}
          </p>

          <div
            v-for="connector in connectors"
            :key="connector.id"
            class="video_slice"
            :class="{ selected: connector.id === selectedId }"
            :style="styleOf(connector)"
            @pointerdown.stop="startMove($event, connector)"
          >
            <span class="video_slice_name">{{ connector.name }}</span>
            <span
              class="video_slice_grip"
              @pointerdown.stop="startResize($event, connector)"
            />
          </div>
        </div>

        <uk-flex
          col
          :gap="6"
          class="video_side"
        >
          <h4>Source</h4>
          <uk-select-input
            :model-value="sourceIndex"
            :options="sourceOptions"
            :disabled="!sources.length"
            @input="pickSource"
          />
          <p class="subtitle">
            {{ status }}
          </p>

          <h4>Connectors</h4>
          <div class="video_list">
            <p
              v-if="!connectors.length"
              class="subtitle"
            >
              None yet — drag a rectangle on the frame.
            </p>
            <button
              v-for="connector in connectors"
              :key="connector.id"
              type="button"
              class="video_list_row"
              :class="{ selected: connector.id === selectedId }"
              @click="selectedId = connector.id"
            >
              {{ connector.name }}
            </button>
          </div>

          <uk-flex :gap="4">
            <uk-button
              label="Add"
              @click="add()"
            />
            <uk-button
              label="Remove"
              :disabled="!selected"
              @click="remove()"
            />
          </uk-flex>

          <uk-checkbox
            v-model="snapEnabled"
            label="Snap to edges"
          />

          <template v-if="selected">
            <h4>{{ selected.name }}</h4>
            <uk-txt-input
              v-model="selectedName"
              label="Name"
            />
            <uk-flex :gap="4">
              <uk-num-input
                v-model="rectX"
                label="X %"
                :min="0"
                :max="100"
                :precision="1"
              />
              <uk-num-input
                v-model="rectY"
                label="Y %"
                :min="0"
                :max="100"
                :precision="1"
              />
            </uk-flex>
            <uk-flex :gap="4">
              <uk-num-input
                v-model="rectW"
                label="W %"
                :min="0"
                :max="100"
                :precision="1"
              />
              <uk-num-input
                v-model="rectH"
                label="H %"
                :min="0"
                :max="100"
                :precision="1"
              />
            </uk-flex>
            <uk-select-input
              label="Aspect"
              :model-value="aspectIndex"
              :options="aspectOptions"
              @input="pickAspect"
            />
            <uk-flex :gap="4">
              <uk-button
                :label="`Rotate ${selected.rotation}°`"
                @click="rotate()"
              />
              <uk-button
                :label="selected.flipH ? 'Flip H ✓' : 'Flip H'"
                @click="toggleFlip('flipH')"
              />
              <uk-button
                :label="selected.flipV ? 'Flip V ✓' : 'Flip V'"
                @click="toggleFlip('flipV')"
              />
            </uk-flex>
            <p class="subtitle">
              {{ pixelSize }}
            </p>
          </template>
        </uk-flex>
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import * as THREE from 'three';
import PopupMixin from '@/views/mixins/popup.mixin';
import VideoFeed from '@/plugins/visualizer/video_feed';
import createVideoMaterial from '@/plugins/visualizer/video_material';
import VideoConnector, { CONNECTOR_ASPECTS } from '@/models/DMX/video_connector';

/**
 * @namespace views/activities/app/fragments/toolbar/popups
 * @component VideoPopup Carves an incoming video frame into named connectors.
 *
 * The one part of the video feature that needs room: slicing is a visual job
 * -- see the frame, draw rectangles on it -- and no list can do it. A popup
 * rather than a docked panel because carving a canvas is a set-up-once task;
 * MadMapper and Resolume stay the mapping tools, and Beam only names regions
 * of what they send.
 */

/**
 * How often the preview redraws, in frames a second.
 *
 * Deliberately far below the feed's own rate. This is a *second* upload of the
 * same frame -- 16.6 MB at 4K -- into a second GL context, and nobody draws
 * rectangles by eye at 30 fps. It runs only while the popup is open.
 */
const PREVIEW_FPS = 10;

/**
 * How close an edge has to come before it snaps, in screen pixels.
 *
 * Screen rather than fractions of the frame, because it is a hand-eye
 * tolerance: the same 6 px feels right whether the source is 1080p or 4K, and
 * the same fraction would not.
 */
const SNAP_PIXELS = 6;

export default {
  name: 'VideoPopup',
  compatConfig: { MODE: 3 },
  mixins: [PopupMixin],
  data() {
    return {
      headerData: { title: 'Video' },
      sources: [],
      sourceName: '',
      feed: null,
      selectedId: null,
      hasPicture: false,
      snapEnabled: true,
      /**
       * The shape the next box gets.
       *
       * Carrying it forward is the point: someone carving a canvas into
       * twelve 16:9 regions chooses the ratio once, not twelve times.
       */
      lastAspect: 0,
      status: 'Looking for sources…',
    };
  },
  computed: {
    /**
     * The show's connectors.
     *
     * Read straight off the reactive show rather than copied: `$show` is
     * `reactive(ShowSingleton)`, so an element read out of this array is a
     * proxy and editing it in place re-renders. A local copy would not.
     */
    connectors() {
      return (this.$show && this.$show.videoConnectors) || [];
    },
    selected() {
      return this.connectors.find((c) => c.id === this.selectedId) || null;
    },
    sourceOptions() {
      if (!this.sources.length) return ['No sources found'];
      return this.sources.map((source) => source.name);
    },
    aspectOptions() {
      return CONNECTOR_ASPECTS.map((entry) => entry.label);
    },
    aspectIndex() {
      if (!this.selected) return 0;
      const at = CONNECTOR_ASPECTS.findIndex(
        (entry) => Math.abs(entry.value - this.selected.aspect) < 1e-6,
      );
      return at < 0 ? 0 : at;
    },
    /**
     * The frame's own pixel aspect, which a locked shape is measured against.
     *
     * Zero until a frame lands, and a zero disables the lock rather than
     * guessing 16:9 -- a wrong guess reshapes the user's rectangles.
     */
    sourceAspect() {
      if (!this.feed || !this.feed.width || !this.feed.height) return 0;
      return this.feed.width / this.feed.height;
    },
    sourceIndex() {
      const at = this.sources.findIndex((source) => source.name === this.sourceName);
      return at < 0 ? 0 : at;
    },
    selectedName: {
      get() { return this.selected ? this.selected.name : ''; },
      set(value) { if (this.selected) this.selected.name = value; },
    },
    rectX: {
      get() { return this.percent('x'); },
      set(value) { this.writeRect({ x: value / 100 }); },
    },
    rectY: {
      get() { return this.percent('y'); },
      set(value) { this.writeRect({ y: value / 100 }); },
    },
    rectW: {
      get() { return this.percent('width'); },
      set(value) { this.writeRect({ width: value / 100 }); },
    },
    rectH: {
      get() { return this.percent('height'); },
      set(value) { this.writeRect({ height: value / 100 }); },
    },
    /**
     * What the region works out to in real pixels.
     *
     * Worth showing rather than leaving to arithmetic: it is the number that
     * decides whether a panel comes out soft, and twelve equal slices of 4K
     * are 960 x 540 each, which surprises people.
     */
    pixelSize() {
      if (!this.selected || !this.feed || !this.feed.width) return '';
      const width = Math.round(this.selected.rect.width * this.feed.width);
      const height = Math.round(this.selected.rect.height * this.feed.height);
      return `${width} × ${height} pixels of ${this.feed.width} × ${this.feed.height}`;
    },
  },
  watch: {
    // The mixin watches `modelValue` too, for `state`. Both run.
    //
    // Immediate, so a popup that is already open when it mounts still goes
    // looking for sources. Relying on the transition alone works for a menu
    // click and silently does nothing for every other way it could arrive
    // open -- which is the sort of thing that only shows up much later.
    modelValue: {
      immediate: true,
      handler(value) {
        if (value) this.opened();
        else this.closed();
      },
    },
  },
  beforeUnmount() {
    this.closed();
  },
  methods: {
    percent(key) {
      if (!this.selected) return 0;
      return Math.round(this.selected.rect[key] * 1000) / 10;
    },
    writeRect(patch) {
      if (this.selected) this.selected.setRect(patch, this.sourceAspect);
    },

    pickAspect(index) {
      const entry = CONNECTOR_ASPECTS[index];
      if (!entry) return;
      this.lastAspect = entry.value;
      if (this.selected) this.selected.setAspect(entry.value, this.sourceAspect);
    },

    async opened() {
      if (!VideoFeed.available()) {
        this.status = 'Video input needs the desktop app.';
        return;
      }
      this.status = 'Looking for sources…';
      this.sources = await VideoFeed.sources();
      if (!this.sources.length) {
        this.status = 'No NDI sources on the network.';
        return;
      }
      if (!this.sources.some((source) => source.name === this.sourceName)) {
        this.sourceName = this.sources[0].name;
      }
      await this.openFeed();
      this.mountPreview();
    },

    pickSource(index) {
      const source = this.sources[index];
      if (!source || source.name === this.sourceName) return;
      this.sourceName = source.name;
      this.hasPicture = false;
      this.openFeed();
    },

    async openFeed() {
      if (this.feed) { this.feed.close(); this.feed = null; }
      this.status = 'Opening…';
      this.feed = await VideoFeed.open(this.sourceName);
      if (!this.feed) this.status = 'Could not open that source.';
      else this.status = 'Waiting for the first frame…';
    },

    /**
     * A WebGL context of this popup's own, drawing the same feed.
     *
     * A texture belongs to the context that uploaded it, so the visualizer's
     * cannot be borrowed. What *is* shared is the bytes: `feed.pixels` is the
     * array the renderer uploaded, and this uploads it again here. That costs
     * a second upload while the popup is open, which is why `PREVIEW_FPS` is
     * low -- this buys something to draw rectangles on, not a monitor.
     */
    mountPreview() {
      const { canvas } = this.$refs;
      if (!canvas || this.renderer) return;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.scene = new THREE.Scene();
      // A unit quad seen straight on, so the frame fills the canvas whatever
      // its aspect -- the element is what carries the shape, below.
      this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
      this.scene.add(this.quad);
      this.lastFrame = -1;
      this.timer = setInterval(() => this.drawPreview(), 1000 / PREVIEW_FPS);
    },

    drawPreview() {
      const { feed } = this;
      if (!feed || !this.renderer || feed.frameCount === this.lastFrame) return;
      this.lastFrame = feed.frameCount;
      const { pixels } = feed;
      if (!pixels) return;

      // Rebuilt when the shape changes, re-pointed when it does not: the feed
      // replaces its array each frame rather than writing into it.
      if (!this.texture
        || this.texture.image.width !== feed.texels
        || this.texture.image.height !== feed.height) {
        if (this.texture) this.texture.dispose();
        const { RGBAFormat, UnsignedByteType } = THREE;
        const { texels, height } = feed;
        this.texture = new THREE.DataTexture(pixels, texels, height, RGBAFormat, UnsignedByteType);
        // Same rules as the renderer's own copy: packed bytes are not a
        // colour, so nothing may be interpolated or colour-managed on the way
        // in. See `video_feed.js`.
        this.texture.colorSpace = feed.format === 'UYVY'
          ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        const filter = feed.format === 'UYVY' ? THREE.NearestFilter : THREE.LinearFilter;
        this.texture.minFilter = filter;
        this.texture.magFilter = filter;
        this.texture.generateMipmaps = false;
        this.texture.flipY = true;
        if (this.quad.material) this.quad.material.dispose();
        this.quad.material = createVideoMaterial(feed, this.texture);
      } else {
        this.texture.image.data = pixels;
      }
      this.texture.needsUpdate = true;

      // The element carries the aspect, so a rectangle drawn on screen selects
      // the region it looks like it selects.
      const { stage } = this.$refs;
      if (stage && stage.clientWidth) {
        const width = stage.clientWidth;
        const height = Math.round((width * feed.height) / feed.width);
        if (stage.style.height !== `${height}px`) stage.style.height = `${height}px`;
        this.renderer.setSize(width, height, false);
      }
      this.renderer.render(this.scene, this.camera);
      this.hasPicture = true;
      this.status = `${feed.width} × ${feed.height} ${feed.format}`;
    },

    /**
     * Everything this popup holds open, released.
     *
     * The receiver especially: it is a network socket and a 16 MB frame every
     * 33 ms, and leaving one running behind a closed dialog is the kind of
     * cost nobody goes looking for.
     */
    closed() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.feed) { this.feed.close(); this.feed = null; }
      if (this.texture) { this.texture.dispose(); this.texture = null; }
      if (this.quad && this.quad.material) this.quad.material.dispose();
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      this.hasPicture = false;
      this.endDrag();
    },

    add() {
      if (!this.$show) return;
      // Laid out in a grid rather than stacked, because pressing Add twice
      // should give two rectangles you can tell apart -- offset ones overlap,
      // and their labels print on top of each other.
      const at = this.connectors.length;
      const size = 0.24;
      const step = 0.25;
      const across = 3;
      const connector = new VideoConnector({
        name: `Connector ${at + 1}`,
        rect: {
          x: 0.02 + (at % across) * step,
          y: 0.02 + (Math.floor(at / across) % across) * step,
          width: size,
          height: size,
        },
        aspect: this.lastAspect,
      });
      connector.setRect({}, this.sourceAspect);
      this.$show.videoConnectors.push(connector);
      this.selectedId = connector.id;
    },

    remove() {
      if (!this.$show || !this.selected) return;
      const at = this.connectors.indexOf(this.selected);
      if (at > -1) this.$show.videoConnectors.splice(at, 1);
      this.selectedId = null;
    },

    rotate() {
      if (this.selected) this.selected.rotate();
    },

    toggleFlip(key) {
      if (this.selected) this.selected[key] = !this.selected[key];
    },

    styleOf(connector) {
      const { rect } = connector;
      return {
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
      };
    },

    /**
     * Every line worth snapping to: the frame's own edges, and both edges of
     * every other connector.
     *
     * The dragged one is left out, or it would snap to where it already is
     * and never move.
     *
     * @param {Object} exclude the connector being dragged
     * @returns {Object} `{ xs, ys, tolX, tolY }`, all normalised
     */
    snapLines(exclude) {
      const { stage } = this.$refs;
      const width = (stage && stage.clientWidth) || 1;
      const height = (stage && stage.clientHeight) || 1;
      const xs = [0, 1];
      const ys = [0, 1];
      this.connectors.forEach((connector) => {
        if (exclude && connector.id === exclude.id) return;
        xs.push(connector.rect.x, connector.rect.x + connector.rect.width);
        ys.push(connector.rect.y, connector.rect.y + connector.rect.height);
      });
      return {
        xs, ys, tolX: SNAP_PIXELS / width, tolY: SNAP_PIXELS / height,
      };
    },

    /**
     * Pulls a single edge onto the nearest line.
     *
     * @param {Number} value the edge, normalised
     * @param {Array} lines candidates
     * @param {Number} tolerance how close counts
     * @returns {Number}
     */
    snapEdge(value, lines, tolerance) {
      if (!this.snapEnabled) return value;
      let best = value;
      let nearest = tolerance;
      lines.forEach((line) => {
        const distance = Math.abs(line - value);
        if (distance < nearest) { nearest = distance; best = line; }
      });
      return best;
    },

    /**
     * Pulls a whole span onto a line by **whichever of its two edges is
     * closer**, so a box can be butted up against a neighbour from either
     * side without the user thinking about which edge they are aiming.
     *
     * @param {Number} lead the leading edge
     * @param {Number} size the span's length
     * @param {Array} lines candidates
     * @param {Number} tolerance
     * @returns {Number} the adjusted leading edge
     */
    snapSpan(lead, size, lines, tolerance) {
      if (!this.snapEnabled) return lead;
      let best = lead;
      let nearest = tolerance;
      lines.forEach((line) => {
        const toLead = Math.abs(line - lead);
        if (toLead < nearest) { nearest = toLead; best = line; }
        const toTrail = Math.abs(line - (lead + size));
        if (toTrail < nearest) { nearest = toTrail; best = line - size; }
      });
      return best;
    },

    /** Where a pointer is, as a fraction of the frame. */
    fractionAt(event) {
      const { stage } = this.$refs;
      if (!stage) return { x: 0, y: 0 };
      const box = stage.getBoundingClientRect();
      if (!box.width || !box.height) return { x: 0, y: 0 };
      return {
        x: (event.clientX - box.left) / box.width,
        y: (event.clientY - box.top) / box.height,
      };
    },

    /**
     * Dragging on the frame draws a new connector.
     *
     * Cheaper than add-then-position for the job people actually do, which is
     * carving a row of regions out of a canvas one after another.
     */
    startDraw(event) {
      if (!this.$show || !this.feed) return;
      const from = this.fractionAt(event);
      const connector = new VideoConnector({
        name: `Connector ${this.connectors.length + 1}`,
        rect: {
          x: from.x, y: from.y, width: 0.005, height: 0.005,
        },
        aspect: this.lastAspect,
      });
      this.$show.videoConnectors.push(connector);
      this.selectedId = connector.id;
      this.drag = { mode: 'draw', from, connector: this.selected };
      this.listen(event);
    },

    startMove(event, connector) {
      this.selectedId = connector.id;
      const at = this.fractionAt(event);
      this.drag = {
        mode: 'move',
        connector,
        grab: { x: at.x - connector.rect.x, y: at.y - connector.rect.y },
      };
      this.listen(event);
    },

    startResize(event, connector) {
      this.selectedId = connector.id;
      const at = this.fractionAt(event);
      // The grip hangs outside the corner it drags, so the pointer is a few
      // pixels past it. Without this the edge jumps to the pointer the instant
      // the drag starts, and every snap is measured from the wrong place.
      this.drag = {
        mode: 'resize',
        connector,
        grab: {
          x: at.x - (connector.rect.x + connector.rect.width),
          y: at.y - (connector.rect.y + connector.rect.height),
        },
      };
      this.listen(event);
    },

    /**
     * Listens on the window, not the element.
     *
     * A drag that leaves the rectangle -- which every resize does, since the
     * grip is at the corner -- would otherwise stop getting moves the moment
     * the pointer crossed the edge.
     */
    listen(event) {
      if (event.target.setPointerCapture) {
        event.target.setPointerCapture(event.pointerId);
      }
      this.moveHandler = (moved) => this.onDrag(moved);
      this.upHandler = () => this.endDrag();
      window.addEventListener('pointermove', this.moveHandler);
      window.addEventListener('pointerup', this.upHandler);
    },

    onDrag(event) {
      if (!this.drag || !this.drag.connector) return;
      const at = this.fractionAt(event);
      const { mode, connector } = this.drag;
      const aspect = this.sourceAspect;
      const {
        xs, ys, tolX, tolY,
      } = this.snapLines(connector);

      if (mode === 'move') {
        const { width, height } = connector.rect;
        connector.setRect({
          x: this.snapSpan(at.x - this.drag.grab.x, width, xs, tolX),
          y: this.snapSpan(at.y - this.drag.grab.y, height, ys, tolY),
        }, aspect);
      } else if (mode === 'resize') {
        // The corner, not the pointer -- they differ by where the grip was
        // grabbed.
        const cornerX = at.x - this.drag.grab.x;
        const cornerY = at.y - this.drag.grab.y;
        const toX = this.snapEdge(cornerX, xs, tolX);
        const toY = this.snapEdge(cornerY, ys, tolY);

        // With a shape locked, only one edge can be obeyed -- the other is
        // derived from it. Obeying the width always meant a locked box could
        // never snap to a horizontal line, which reads as snapping being
        // broken rather than as a consequence of the lock. So whichever edge
        // actually caught a line, and by the smaller margin, leads.
        const caughtX = toX !== cornerX;
        const caughtY = toY !== cornerY;
        const leadY = connector.aspect > 0 && caughtY
          && (!caughtX || Math.abs(toY - cornerY) * tolX < Math.abs(toX - cornerX) * tolY);
        if (leadY) {
          connector.setRect({ height: toY - connector.rect.y }, aspect);
        } else {
          connector.setRect({
            width: toX - connector.rect.x,
            height: toY - connector.rect.y,
          }, aspect);
        }
      } else {
        const { from } = this.drag;
        const toX = this.snapEdge(at.x, xs, tolX);
        const toY = this.snapEdge(at.y, ys, tolY);
        // The corner the drag started from snaps too, so a box drawn against
        // a neighbour lands flush on both sides rather than only the last.
        const fromX = this.snapEdge(from.x, xs, tolX);
        const fromY = this.snapEdge(from.y, ys, tolY);
        connector.setRect({
          x: Math.min(fromX, toX),
          y: Math.min(fromY, toY),
          width: Math.abs(toX - fromX),
          height: Math.abs(toY - fromY),
        }, aspect);
      }
    },

    endDrag() {
      if (this.moveHandler) window.removeEventListener('pointermove', this.moveHandler);
      if (this.upHandler) window.removeEventListener('pointerup', this.upHandler);
      this.moveHandler = null;
      this.upHandler = null;
      this.drag = null;
    },
  },
};
</script>

<style scoped>
/* Plain CSS, like every other component here -- nothing in this repo
   preprocesses, and `lang="scss"` fails the dev server outright. */
.body {
  width: 860px;
  max-width: 92vw;
}

.title .subtitle { max-width: 640px; }

.video_stage {
  position: relative;
  flex: 1;
  min-width: 460px;
  min-height: 260px;
  overflow: hidden;
  background: #101010;
  border: 1px solid #2a2a2a;
  cursor: crosshair;
}

.video_canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.video_stage_empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: #7a7a7a;
}

.video_slice {
  position: absolute;
  cursor: move;
  background: rgba(90, 200, 220, 0.12);
  border: 1px solid rgba(120, 230, 255, 0.95);
  /* A light line alone vanishes on a light frame, and a test pattern is mostly
     white. The dark ring either side of it means the edge reads on anything --
     the same trick a marquee has always used. */
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.75),
    inset 0 0 0 1px rgba(0, 0, 0, 0.75);
}

.video_slice.selected {
  background: rgba(255, 255, 255, 0.14);
  border-color: #fff;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.9),
    inset 0 0 0 1px rgba(0, 0, 0, 0.9);
}

.video_slice_name {
  position: absolute;
  top: 2px;
  left: 4px;
  /* Named explicitly: `global.css` styles h1-h4, p and button, and sets no
     font on body -- so anything else falls through to the browser default,
     which is a serif. */
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: #fff;
  /* Outlined rather than dropped, for the same reason as the border. */
  text-shadow:
    0 0 3px rgba(0, 0, 0, 0.95),
    0 1px 2px rgba(0, 0, 0, 0.95);
  white-space: nowrap;
  pointer-events: none;
}

.video_slice_grip {
  position: absolute;
  right: -6px;
  bottom: -6px;
  /* Bigger than it looks like it needs to be. At 9 px half the target hung
     outside the box, and a miss lands on the box instead -- which starts a
     move. "Movement snaps but sizing doesn't" is what that feels like from
     the outside, because the resize never began. */
  width: 13px;
  height: 13px;
  cursor: nwse-resize;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.9);
  touch-action: none;
}

.video_side {
  flex: none;
  width: 264px;
}

.video_list {
  max-height: 150px;
  overflow-y: auto;
  border: 1px solid #2a2a2a;
}

.video_list_row {
  display: block;
  width: 100%;
  padding: 4px 8px;
  /* Not `font: inherit`. That is what put Times in here: it overrides the
     global `button` rule with whatever the parent has, and nothing up the
     chain sets a family. The list also keeps the user's own capitals, where
     the global button rule uppercases. */
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter);
  text-align: left;
  text-transform: none;
  cursor: pointer;
  background: none;
  border: 0;
}

.video_list_row:hover { background: rgba(255, 255, 255, 0.06); }
.video_list_row.selected { background: rgba(90, 200, 220, 0.25); }
</style>
