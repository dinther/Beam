<template>
  <uk-popup
    v-model="state"
    :header="headerData"
    no-validation
    @input="update()"
  >
    <uk-flex
      class="body"
      :gap="16"
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

      <!-- Top row: what arrived, and the connectors carved out of it. -->
      <uk-flex :gap="20">
        <!-- The frame, with the rectangles over it. The canvas is drawn by a
             WebGL context of this popup's own -- see `mountPreview` -- because
             a texture belongs to the context that uploaded it. -->
        <div
          ref="stage"
          class="video_stage"
        >
          <!-- The picture is its own element inside the stage, and every
               rectangle is positioned against *it* rather than against the
               stage. The stage is the panel; the picture only ever takes the
               shape of the frame. Keeping them separate means a stage left
               taller than the frame letterboxes rather than stretching it. -->
          <div
            ref="picture"
            class="video_picture"
            @pointerdown="startDraw"
          >
            <canvas
              ref="canvas"
              class="video_canvas"
            />
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
          <p
            v-if="!hasPicture"
            class="video_stage_empty"
          >
            {{ status }}
          </p>
        </div>

        <div class="video_side">
          <section class="video_section">
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
          </section>

          <section class="video_section">
            <h4>Connectors</h4>
            <div class="video_list">
              <p
                v-if="!connectors.length"
                class="subtitle video_list_empty"
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

            <uk-flex :gap="6">
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
          </section>
        </div>
      </uk-flex>

      <!-- Bottom row: the selected connector alone -- what leaves for the
           device, and the numbers that decide it. Absent entirely when
           nothing is selected, rather than sitting there empty. -->
      <uk-flex
        v-if="selected"
        :gap="20"
        class="video_bottom"
      >
        <!-- The only place a turn or a mirror becomes visible. The frame above
             always draws the rectangle in the *source's* axes, so pressing
             Rotate changes nothing there and reads as a button that does not
             work. -->
        <section class="video_col video_col_preview">
          <h4>Sent to the device</h4>
          <div
            ref="output"
            class="video_output"
          >
            <canvas
              ref="outputCanvas"
              class="video_output_canvas"
            />
            <p
              v-if="!hasPicture"
              class="video_output_empty"
            >
              No picture
            </p>
          </div>
          <p class="subtitle">
            {{ outputLabel }}
          </p>
        </section>

        <section class="video_col">
          <h4>{{ selected.name }}</h4>
          <uk-txt-input
            v-model="selectedName"
            label="Name"
          />
          <!-- In the frame's own pixels once one has arrived, because a
               percentage cannot name a pixel boundary: a tenth of a percent of
               a 4K frame is nearly four of them. Percentages remain the
               fallback for a connector edited with no source connected. -->
          <uk-flex :gap="8">
            <uk-num-input
              v-model="rectX"
              :label="`X ${rectUnit}`"
              :min="0"
              :max="rectMax.x"
              :precision="rectPrecision"
            />
            <uk-num-input
              v-model="rectY"
              :label="`Y ${rectUnit}`"
              :min="0"
              :max="rectMax.y"
              :precision="rectPrecision"
            />
          </uk-flex>
          <uk-flex :gap="8">
            <uk-num-input
              v-model="rectW"
              :label="`W ${rectUnit}`"
              :min="rectPrecision === 0 ? 1 : 0"
              :max="rectMax.x"
              :precision="rectPrecision"
            />
            <uk-num-input
              v-model="rectH"
              :label="`H ${rectUnit}`"
              :min="rectPrecision === 0 ? 1 : 0"
              :max="rectMax.y"
              :precision="rectPrecision"
            />
          </uk-flex>
          <p class="subtitle">
            {{ pixelSize }}
          </p>
        </section>

        <section class="video_col">
          <h4>Shape and orientation</h4>
          <uk-select-input
            label="Aspect"
            :model-value="aspectIndex"
            :options="aspectOptions"
            @input="pickAspect"
          />
          <uk-flex :gap="6">
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
        </section>
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import * as THREE from 'three';
import PopupMixin from '@/views/mixins/popup.mixin';
import VideoFeed from '@/plugins/visualizer/video_feed';
import VideoRouter from '@/plugins/visualizer/video_router';
import Preferences from '@/plugins/visualizer/preferences';
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

/**
 * The tallest the "sent to the device" preview may be, in pixels.
 *
 * It is a confidence check, not a monitor: big enough to see which way up the
 * content is and that the crop took the region meant, small enough that it
 * never pushes the controls it explains off the bottom of the column. A
 * portrait connector is what makes a cap necessary at all.
 */
const OUTPUT_MAX_HEIGHT = 132;

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
      /**
       * The frame's size, mirrored here rather than read off the feed.
       *
       * `VideoFeed.width` is a getter over a field the receiver assigns when
       * the first frame lands -- on the raw instance, not through the proxy
       * this holds it in. So a computed that read it while the feed was still
       * empty caches a zero and is never invalidated, however many frames
       * arrive. That is a silent wrong answer rather than a crash: the pixel
       * readouts come out blank, and `sourceAspect` reads 0, which disables
       * the shape lock without saying so.
       *
       * Written from `drawPreview`, which already reads both for the status
       * line, so it also follows a source being switched mid-session.
       */
      frameWidth: 0,
      frameHeight: 0,
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
      if (!this.frameWidth || !this.frameHeight) return 0;
      return this.frameWidth / this.frameHeight;
    },
    sourceIndex() {
      const at = this.sources.findIndex((source) => source.name === this.sourceName);
      return at < 0 ? 0 : at;
    },
    selectedName: {
      get() { return this.selected ? this.selected.name : ''; },
      set(value) { if (this.selected) this.selected.name = value; },
    },
    /** True once a frame has arrived and the fields can speak in pixels. */
    inPixels() {
      return !!(this.frameWidth && this.frameHeight);
    },
    rectUnit() { return this.inPixels ? 'px' : '%'; },
    rectPrecision() { return this.inPixels ? 0 : 1; },
    rectMax() {
      return this.inPixels
        ? { x: this.frameWidth, y: this.frameHeight }
        : { x: 100, y: 100 };
    },
    rectX: {
      get() { return this.readRect('x'); },
      set(value) { this.writeAxis('x', value); },
    },
    rectY: {
      get() { return this.readRect('y'); },
      set(value) { this.writeAxis('y', value); },
    },
    rectW: {
      get() { return this.readRect('width'); },
      set(value) { this.writeAxis('width', value); },
    },
    rectH: {
      get() { return this.readRect('height'); },
      set(value) { this.writeAxis('height', value); },
    },
    /**
     * What the region works out to in real pixels.
     *
     * Worth showing rather than leaving to arithmetic: it is the number that
     * decides whether a panel comes out soft, and twelve equal slices of 4K
     * are 960 x 540 each, which surprises people.
     */
    pixelSize() {
      if (!this.selected || !this.frameWidth) return '';
      const width = Math.round(this.selected.rect.width * this.frameWidth);
      const height = Math.round(this.selected.rect.height * this.frameHeight);
      return `${width} × ${height} pixels of ${this.frameWidth} × ${this.frameHeight}`;
    },
    /**
     * What the device actually receives, said in words.
     *
     * The size leads because a quarter turn transposes it, and a portrait
     * panel fed 960 x 540 is the mistake this whole preview exists to catch.
     * The turn and the mirrors follow, named rather than lettered -- "mirrored
     * left-right" survives being read next to a picture, where "flipH" only
     * repeats the button.
     */
    outputLabel() {
      if (!this.selected || !this.frameWidth) return '';
      const { width, height } = this.selected.outputSize(this.frameWidth, this.frameHeight);
      const parts = [`${width} × ${height}`];
      if (this.selected.rotation) parts.push(`turned ${this.selected.rotation}° clockwise`);
      if (this.selected.flipH) parts.push('mirrored left-right');
      if (this.selected.flipV) parts.push('mirrored top-bottom');
      return parts.join(' · ');
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
    /**
     * One edge of the region, in whichever unit the fields are showing.
     *
     * @param {String} key x, y, width or height
     * @returns {Number}
     */
    readRect(key) {
      if (!this.selected) return 0;
      if (!this.inPixels) return this.percent(key);
      const pixels = this.selected.pixelRect(this.frameWidth, this.frameHeight);
      return pixels ? pixels[key] : 0;
    },
    /**
     * Writes one edge back, in whichever unit the fields are showing.
     *
     * @param {String} key x, y, width or height
     * @param {Number} value
     */
    writeAxis(key, value) {
      if (!this.selected) return;
      if (!this.inPixels) {
        this.writeRect({ [key]: value / 100 });
        return;
      }
      this.selected.setPixelRect({ [key]: value }, this.frameWidth, this.frameHeight);
      this.announce();
    },
    writeRect(patch) {
      if (this.selected) this.selected.setRect(patch, this.sourceAspect);
      this.announce();
    },
    /**
     * Tells whatever is showing a connector that its rectangle moved.
     *
     * Carving a slice with a display already on it should update the display,
     * which is the whole point of being able to see both at once.
     *
     * @public
     */
    announce() {
      VideoRouter.touch();
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
      // The scene follows what is picked here. A device shows a *connector*,
      // and a connector says which part of a picture -- this says which picture
      // -- so choosing a source is the one act that binds the two. Deliberately
      // not automatic: a feed is a network receiver, and opening one is a
      // user's decision, not the app's.
      VideoRouter.select(this.sourceName);
      // Remembered, so a project full of video panels comes up connected rather
      // than black until someone opens this popup. See `restoreVideoSource`.
      Preferences.set('videoSource', this.sourceName);
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

      // A second quad for the "sent to the device" preview, drawn by the same
      // renderer from the same texture -- see `drawSlice`. Its own scene
      // rather than a visibility toggle, so neither draw can ever include the
      // other's quad.
      this.sliceScene = new THREE.Scene();
      this.sliceQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
      this.sliceScene.add(this.sliceQuad);
      // The plane's own corners, kept because `writeSliceUvs` overwrites the
      // attribute it would otherwise be reading from.
      this.sliceBaseUv = Float32Array.from(this.sliceQuad.geometry.attributes.uv.array);

      this.lastFrame = -1;
      this.lastSignature = '';
      this.timer = setInterval(() => this.drawPreview(), 1000 / PREVIEW_FPS);
    },

    /**
     * Everything the slice preview depends on besides the picture itself.
     *
     * The frame counter alone is not enough to decide whether to redraw: a
     * feed that has stalled, or one arriving slower than the preview's own
     * 10 fps, would leave a flip or a quarter turn showing the previous
     * arrangement until the next frame landed -- which is indistinguishable
     * from the button having done nothing.
     *
     * @returns {String}
     */
    sliceSignature() {
      const connector = this.selected;
      if (!connector) return '';
      const { rect } = connector;
      return [
        connector.id, rect.x, rect.y, rect.width, rect.height,
        connector.rotation, connector.flipH, connector.flipV,
      ].join(':');
    },

    drawPreview() {
      const { feed } = this;
      if (!feed || !this.renderer) return;
      const { pixels } = feed;
      if (!pixels) return;

      const fresh = feed.frameCount !== this.lastFrame;
      const signature = this.sliceSignature();
      if (!fresh && signature === this.lastSignature) return;
      this.lastFrame = feed.frameCount;
      this.lastSignature = signature;

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
        // Shared, not a second one: the unpacking is identical and a UYVY
        // material carries the picture size as a uniform, so two of them are
        // two things to keep in step for no gain.
        this.sliceQuad.material = this.quad.material;
      } else {
        this.texture.image.data = pixels;
      }
      // Only when a frame actually arrived. Re-uploading is 8 MB at 4K, and
      // this method now also runs when nothing has changed but a flip.
      if (fresh) this.texture.needsUpdate = true;

      this.drawSlice();

      const size = this.fitPicture(feed);
      if (size) {
        this.renderer.setSize(size.width, size.height, false);
        this.renderer.render(this.scene, this.camera);
      }
      this.hasPicture = true;
      if (this.frameWidth !== feed.width) this.frameWidth = feed.width;
      if (this.frameHeight !== feed.height) this.frameHeight = feed.height;
      this.status = `${feed.width} × ${feed.height} ${feed.format}`;
    },

    /**
     * Sizes the frame to fit inside the stage, keeping its shape, and lets the
     * stage centre it.
     *
     * Fitting rather than filling is the whole point. The stage stretches to
     * whatever height the controls beside it need, which is far more than a
     * 16:9 frame wants -- and sizing the frame from the width alone left the
     * difference as a slab of empty panel underneath it. What is left over is
     * now letterboxing inside a dark viewer, which reads as deliberate.
     *
     * The picture carries the aspect, so a rectangle drawn on screen selects
     * the region it looks like it selects.
     *
     * @param {Object} feed
     * @returns {Object} `{ width, height }` in pixels, or null before layout
     */
    fitPicture(feed) {
      const { stage, picture } = this.$refs;
      if (!stage || !picture || !stage.clientWidth) return null;
      // Driven by the width alone. The stage's own height follows the picture,
      // so measuring the stage's height here would be circular -- and with the
      // connector list beside it rather than the whole property panel, there
      // is no longer anything forcing the stage taller than its picture.
      const width = stage.clientWidth;
      const height = Math.max(1, Math.round((width * feed.height) / feed.width));
      if (picture.style.width !== `${width}px`) picture.style.width = `${width}px`;
      if (picture.style.height !== `${height}px`) picture.style.height = `${height}px`;
      return { width, height };
    },

    /**
     * How big the preview may be, shaped like what the device receives.
     *
     * The shape carries the message: a connector turned a quarter turn out of
     * a landscape frame shows up here as a *tall* box, which is the effect the
     * Rotate button is being asked to explain and which no number in a field
     * conveys.
     *
     * @returns {Object} `{ width, height }` in pixels, zeroes when not ready
     */
    outputBox() {
      const holder = this.$refs.output;
      const room = (holder && holder.clientWidth) || 0;
      const aspect = this.selected ? this.selected.outputAspect(this.sourceAspect) : 0;
      if (!room || !aspect) return { width: 0, height: 0 };
      let width = room;
      let height = width / aspect;
      if (height > OUTPUT_MAX_HEIGHT) {
        height = OUTPUT_MAX_HEIGHT;
        width = height * aspect;
      }
      return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    },

    /**
     * Points the preview quad's corners at the region the connector describes.
     *
     * Applied to four corners rather than in a shader, because that is all it
     * is: a crop, a quarter turn and two mirrors are one permutation of the
     * same four pairs, and `VideoConnector.sampleAt` already owns what that
     * permutation means. Nothing in `video_material.js` has to learn that a
     * connector exists, and the device path will read the same method.
     *
     * The inversions in `y` are the *texture's*, not the connector's: the
     * frame is uploaded with `flipY`, so v = 1 is the picture's top row, while
     * every coordinate on a connector counts downwards from the top-left.
     *
     * @param {VideoConnector} connector
     */
    writeSliceUvs(connector) {
      const attribute = this.sliceQuad.geometry.attributes.uv;
      const base = this.sliceBaseUv;
      for (let i = 0; i < attribute.count; i += 1) {
        const at = connector.sampleAt(base[i * 2], 1 - base[i * 2 + 1]);
        attribute.setXY(i, at.x, 1 - at.y);
      }
      attribute.needsUpdate = true;
    },

    /**
     * The selected region as the device receives it: cropped, turned, mirrored.
     *
     * Drawn with the **same renderer** as the frame above and copied out,
     * rather than given a context of its own. A texture belongs to the context
     * that uploaded it, so a second context means a third copy of a frame that
     * is already 16 MB at 4K -- the same reason `mountPreview` gives for not
     * borrowing the visualizer's.
     *
     * The copy is taken in the same task as the draw, which is what makes it
     * safe without `preserveDrawingBuffer`: the drawing buffer is cleared when
     * the browser composites, not when `render` returns. Do not defer it.
     *
     * The caller draws the full frame afterwards, so the shared canvas is left
     * showing the picture rather than the slice.
     */
    drawSlice() {
      const canvas = this.$refs.outputCanvas;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      const box = this.outputBox();

      // Nothing selected, or a shape not known yet. Cleared rather than left
      // alone: a stale slice under a different connector's name is worse than
      // an empty box.
      if (!this.selected || !this.sliceQuad || !box.width) {
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      this.writeSliceUvs(this.selected);
      this.renderer.setSize(box.width, box.height, false);
      this.renderer.render(this.sliceScene, this.camera);

      if (canvas.width !== box.width) canvas.width = box.width;
      if (canvas.height !== box.height) canvas.height = box.height;
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      if (!context) return;
      context.clearRect(0, 0, box.width, box.height);
      context.drawImage(this.renderer.domElement, 0, 0, box.width, box.height);
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
      if (this.sliceQuad) {
        // Disposed before the shared material is, and harmlessly twice when
        // they are the same object -- three's dispose only fires an event.
        if (this.sliceQuad.material) this.sliceQuad.material.dispose();
        this.sliceQuad.geometry.dispose();
        this.sliceQuad = null;
        this.sliceScene = null;
      }
      if (this.quad && this.quad.material) this.quad.material.dispose();
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      this.hasPicture = false;
      this.frameWidth = 0;
      this.frameHeight = 0;
      this.lastSignature = '';
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
        name: `HDMI ${at + 1}`,
        rect: {
          x: 0.02 + (at % across) * step,
          y: 0.02 + (Math.floor(at / across) % across) * step,
          width: size,
          height: size,
        },
        aspect: this.lastAspect,
      });
      connector.setRect({}, this.sourceAspect);
      // So it is written down in the pixels of the frame it was drawn against.
      connector.useFrame(this.frameWidth, this.frameHeight);
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
      this.announce();
    },

    toggleFlip(key) {
      if (this.selected) this.selected[key] = !this.selected[key];
      this.announce();
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
      // The picture, not the stage: the tolerance is a distance on the *frame*,
      // and the stage is now larger than the frame by however much letterboxing
      // the controls beside it force.
      const { picture } = this.$refs;
      const width = (picture && picture.clientWidth) || 1;
      const height = (picture && picture.clientHeight) || 1;
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
      const { picture } = this.$refs;
      if (!picture) return { x: 0, y: 0 };
      const box = picture.getBoundingClientRect();
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
        name: `HDMI ${this.connectors.length + 1}`,
        rect: {
          x: from.x, y: from.y, width: 0.005, height: 0.005,
        },
        aspect: this.lastAspect,
      });
      connector.useFrame(this.frameWidth, this.frameHeight);
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
        this.announce();
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
   preprocesses, and `lang="scss"` fails the dev server outright. Colours come
   from the palette in `global.css` rather than from literals, so this panel
   follows the app if the theme ever moves. */
.body {
  /* The house padding, which this popup was missing entirely -- it is most of
     why everything read as crammed against the edges. */
  padding: 16px;
  width: 1040px;
  max-width: 94vw;
}

.title {
  border-bottom: 1px solid var(--primary-dark);
}

.title .subtitle { max-width: 640px; }

/* --- the frame ------------------------------------------------------- */

.video_stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 460px;
  /* Only so the empty state has somewhere to sit; once a frame lands the
     picture's own height governs. */
  min-height: 260px;
  overflow: hidden;
  background: var(--primary-dark);
  border: 1px solid var(--primary-lighter);
}

.video_picture {
  position: relative;
  cursor: crosshair;
}

.video_canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.video_stage_empty {
  position: absolute;
  margin: 0;
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: var(--secondary-light-alt);
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

/* --- the controls ---------------------------------------------------- */

.video_side {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 280px;
}

/* One rule carries the whole rhythm of the column: a rule and equal air on
   both sides of it. Between sections rather than around every control, so the
   groupings are what the eye picks up rather than a uniform stripe of gaps. */
.video_section + .video_section {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--primary-dark);
}

.video_section > * + * {
  margin-top: 10px;
}

.video_section h4 {
  margin: 0 0 2px;
}

.video_section .subtitle {
  /* The house `.subtitle` carries a bottom margin meant for stacked prose; in
     a section the spacing is the section's job, and the two together left a
     ragged gap above every rule. */
  margin-bottom: 0;
}

.video_list {
  max-height: 150px;
  overflow-y: auto;
  background: var(--primary-dark-alt);
  border: 1px solid var(--primary-dark);
}

.video_list_empty {
  margin: 0;
  padding: 8px;
}

.video_list_row {
  display: block;
  width: 100%;
  padding: 6px 10px;
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

.video_list_row:hover { background: var(--secondary-darker); }

.video_list_row.selected {
  color: #fff;
  background: var(--accent-blue);
}

/* --- what the device receives ---------------------------------------- */

/* The bottom row is one band of its own, so it gets the rule rather than each
   column carrying one -- three vertical rules would fence the columns off from
   each other when they describe the same connector. */
.video_bottom {
  padding-top: 18px;
  border-top: 1px solid var(--primary-dark);
}

.video_col {
  flex: 1;
  min-width: 0;
}

.video_col_preview {
  flex: none;
  width: 248px;
}

.video_col > * + * {
  margin-top: 10px;
}

.video_col h4 {
  margin: 0 0 2px;
}

.video_col .subtitle {
  margin-bottom: 0;
}

.video_output {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  /* A fixed frame for a picture whose shape changes underneath it: a quarter
     turn must move the *canvas*, not resize the panel around it and shuffle
     the two columns beside it. */
  height: 140px;
  /* A checkerboard would be busier than the picture; a flat dark ground makes
     the crop's own edges the only lines in the box. */
  background: var(--primary-dark);
  border: 1px solid var(--primary-lighter);
}

.video_output_canvas {
  display: block;
}

.video_output_empty {
  position: absolute;
  margin: 0;
  /* Named explicitly, for the same reason as every other label here: nothing
     sets a font on `body`, so the fallback is a serif. */
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
</style>
