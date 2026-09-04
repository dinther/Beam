<template>
  <uk-flex
    col
    class="visualizer"
    :class="{ hidden }"
  >
    <uk-flex
      class="header"
      gap="12"
    >
      <h3>Visualizer</h3>
      <uk-button
        v-show="!hidden"
        :key="`translate-${gizmoMode}-${modeTick}`"
        square
        icon-only
        label="Move (T)"
        :value="false"
        toggleable
        :model-value="gizmoMode === 'translate'"
        icon="move"
        color="var(--accent-blue)"
        @click="setGizmoMode('translate')"
      />
      <uk-button
        v-show="!hidden"
        :key="`rotate-${gizmoMode}-${modeTick}`"
        square
        icon-only
        label="Rotate (R)"
        :value="false"
        toggleable
        :model-value="gizmoMode === 'rotate'"
        icon="rotate"
        color="var(--accent-blue)"
        @click="setGizmoMode('rotate')"
      />
      <div
        v-show="!hidden"
        class="tool_divider"
      />
      <uk-button
        v-show="!hidden"
        v-model="snapEnabled"
        square
        icon-only
        label="Snap to grid"
        :value="false"
        toggleable
        icon="snap"
        color="var(--accent-blue)"
        @click="toggleSnap"
      />
      <uk-button
        v-show="!hidden"
        square
        icon-only
        label="Fit to view"
        icon="fit"
        @click="$show.visualizerHandle.frameAll()"
      />
      <uk-button
        v-show="!hidden"
        v-model="houseLights"
        square
        icon-only
        label="House lights"
        :value="false"
        toggleable
        icon="lightbulb"
        color="var(--accent-blue)"
        @click="toggleHouseLights"
      />
      <div
        v-show="!hidden"
        class="tool_divider"
      />
      <uk-button
        v-show="!hidden"
        square
        icon-only
        label="Copy (Ctrl+C)"
        icon="copy"
        :disabled="!hasSelection"
        @click="copySelection"
      />
      <uk-button
        v-show="!hidden"
        square
        icon-only
        label="Paste (Ctrl+V)"
        icon="paste"
        :disabled="!canPaste"
        @click="pasteClipboard"
      />
      <uk-button
        v-show="!hidden"
        square
        icon-only
        label="Delete (Del)"
        icon="trash"
        :disabled="!hasSelection"
        @click="deleteSelection"
      />
      <uk-spacer />
      <!-- A plain button, not a toggle: it names where it takes you, and it
           keeps one colour in both modes. A toggleable one lights up in its
           active state, which would say "recording" when it means "here". -->
      <uk-button
        v-show="!hidden"
        square
        :label="studioActive ? 'To Editor' : 'To Studio'"
        @click="toggleStudio"
      />
      <uk-button
        v-show="!hidden"
        v-model="autoRotate"
        square
        label="auto-rotate"
        :value="false"
        toggleable
        icon="goborotation"
        color="var(--accent-violet)"
        @click="toggleAutoRotation"
      />
      <uk-button
        v-show="!hidden"
        v-model="autoFocus"
        square
        label="auto-focus"
        :value="false"
        toggleable
        icon="focus"
        color="var(--accent-blue)"
        @click="toggleAutoFocus"
      />
      <uk-button
        v-show="!hidden"
        icon="hide"
        style="margin-right: 8px"
        label="Hide"
        @click="toggleVisibility"
      />
      <uk-icon
        v-show="hidden"
        name="hide"
        style="fill: var(--secondary-lighter); cursor: pointer"
        @click="toggleVisibility"
      />
    </uk-flex>

    <canvas
      v-show="!hidden"
      id="visualizer"
      ref="visualizer"
      class="visualizer"
      :class="{ framed: studioActive }"
      :style="studioActive ? { '--record-aspect': studioAspect } : null"
    />
  </uk-flex>
</template>

<script>
import Visualizer from '@/plugins/visualizer/visualizer';
import EventBus from '@/plugins/eventbus';
import Clipboard from '@/models/DMX/clipboard';
import Selection from '@/models/DMX/selection';
import Studio from '@/models/DMX/studio';

/**
 * How often the live camera's stored viewpoint is refreshed while orbiting.
 *
 * Fast enough that the position fields read as live, slow enough that a drag is
 * not writing to a reactive store sixty times a second.
 */
const CAMERA_SYNC_MS = 100;

export default {
  name: 'VisualizerFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  data() {
    return {
      /**
       * handle to visualizer instance
       */
      visualizerHandle: null,
      /**
       * handle to popup window
       */
      popupHandle: null,
      /**
       * Visibility state
       */
      hidden: false,
      /**
       * Autofocus state
       */
      autoFocus: false,
      snapEnabled: true,
      houseLights: true,
      /**
       * Which transform tool the gizmo is in, 'translate' or 'rotate'. Held
       * here rather than read straight off the visualizer so the buttons have
       * something reactive to light up from.
       */
      gizmoMode: 'translate',
      /**
       * Bumped on every mode click, purely to re-key the two mode buttons.
       * uk-button flips its own toggle on click, so without a remount the
       * active tool un-highlights when it is clicked again.
       */
      modeTick: 0,
      /** Interval keeping the live camera level with the view. */
      cameraSyncHandle: null,
      /**
       * Auto rotation state
       */
      autoRotate: false,
    };
  },

  computed: {
    /**
     * Whether anything is selected, which is what copy and delete act on.
     *
     * Read from the selection store rather than from the scene, so the buttons
     * follow a pick made in the item list as readily as one made here.
     *
     * @property {Boolean} hasSelection
     */
    hasSelection() {
      return Selection.items.length > 0;
    },
    /**
     * Whether there is anything to paste.
     *
     * The clipboard's chunk lives in a `reactive`, so this lights up the moment
     * a copy is made anywhere -- the key, the button, or the item list.
     *
     * @property {Boolean} canPaste
     */
    canPaste() {
      return !Clipboard.isEmpty;
    },
    /**
     * Whether the app is in studio mode.
     *
     * @property {Boolean} studioActive
     */
    studioActive() {
      return Studio.state.active;
    },
    /**
     * The recording frame as a CSS `aspect-ratio`, for the letterbox.
     *
     * @property {String} studioAspect
     */
    studioAspect() {
      return Studio.aspect;
    },
    /**
     * The frame and lens the canvas should compose for.
     *
     * A single computed so one watcher covers a resize, a lens change and a cut
     * to another camera -- three things that all mean "recompose".
     *
     * @property {Object} studioShot
     */
    studioShot() {
      return Studio.shot;
    },
    /**
     * Which camera is live.
     *
     * @property {String} activeCameraId
     */
    activeCameraId() {
      return Studio.state.activeCameraId;
    },
  },

  watch: {
    /**
     * Entering studio mode pins the canvas to the recording's frame and moves
     * to the selected camera; leaving gives the canvas back to the panel and
     * returns to the editor's own view.
     *
     * The editor keeps its viewpoint across the round trip, which is the point:
     * filming from a camera placed across the room should not cost you the
     * position you were working from.
     *
     * @param {Boolean} value
     */
    studioActive(value) {
      const handle = this.$show.visualizerHandle;
      if (!handle) return;
      if (value) {
        // Editor mode's live camera is always the editor camera, so what is on
        // screen now belongs to it.
        Studio.captureInto(Studio.SCENE_CAMERA_ID, handle.viewpoint);
        this.applyShot();
        this.applyCamera(Studio.state.activeCameraId);
        this.startCameraSync();
      } else {
        this.stopCameraSync();
        if (!Studio.isCameraLocked(Studio.state.activeCameraId)) {
          Studio.captureInto(Studio.state.activeCameraId, handle.viewpoint);
        }
        handle.endRecordingFrame();
        this.applyCamera(Studio.SCENE_CAMERA_ID);
      }
    },
    /**
     * Cutting to another camera.
     *
     * The one being left keeps whatever the view had become, so orbiting while
     * a camera is live is how you adjust it -- there is no separate "save".
     *
     * @param {String} value
     * @param {String} previous
     */
    activeCameraId(value, previous) {
      if (!this.studioActive) return;
      const handle = this.$show.visualizerHandle;
      // Where the camera being left ended up, saved BEFORE anything moves.
      if (handle && previous && !Studio.isCameraLocked(previous)) {
        Studio.captureInto(previous, handle.viewpoint);
      }

      const { seconds } = Studio.state.transition;
      // Asked for per change, by the button that was pressed, rather than read
      // from a mode. A fly only makes sense between two cameras -- arriving in
      // studio mode has nothing to travel from, so that still snaps.
      const wantsFly = Studio.state.flyRequested;
      Studio.state.flyRequested = false;
      if (wantsFly && handle && previous) {
        const camera = Studio.state.cameras.find((c) => c.id === value);
        handle.flyToViewpoint(Studio.viewpointOf(value), {
          seconds,
          easing: 'inOut',
          fov: camera ? camera.fov : undefined,
        });
        return;
      }
      this.applyCamera(value);
    },
    /**
     * Follows the frame and the lens while studio mode is on.
     */
    studioShot: {
      deep: true,
      handler() {
        if (this.studioActive) this.applyShot();
      },
    },
  },

  async mounted() {
    this.$show.visualizerHandle = new Visualizer(this.$refs.visualizer);
    await this.$show.visualizerHandle.init();
    // Workspace settings, applied from their own store rather than from a show.
    this.$show.visualizerHandle.preferences = null;
    new ResizeObserver(
      this.$show.visualizerHandle.resize.bind(this.$show.visualizerHandle),
    ).observe(this.$refs.visualizer);
    EventBus.emit('visualizer_loaded', true);
    this.autoFocus = this.$show.visualizerHandle.autoFocus;
    this.snapEnabled = this.$show.visualizerHandle.snapEnabled;
    this.houseLights = this.$show.visualizerHandle.houseLights;
    this.autoRotate = this.$show.visualizerHandle.autoRotate;
    this.gizmoMode = this.$show.visualizerHandle.gizmoMode;
    // T and R still switch tools, so the buttons follow the keys as well as
    // drive them.
    EventBus.on('gizmo_mode', this.setGizmoModeFromScene);
  },
  beforeUnmount() {
    EventBus.off('gizmo_mode', this.setGizmoModeFromScene);
  },
  methods: {
    /**
     * Copies the selection.
     *
     * Announced rather than done here, exactly as Ctrl+C is: what a fixture or
     * a structure means when it is copied -- a container taking its members
     * with it -- is the show's business, and the show is not something the
     * visualizer reaches into.
     *
     * Copied rather than passed by reference: what consumes this changes the
     * selection the entries came from.
     *
     * @public
     */
    copySelection() {
      if (!this.hasSelection) return;
      EventBus.emit('copy_requested', Selection.items.map((entry) => ({ ...entry })));
    },
    /**
     * Pastes whatever was last copied.
     *
     * @public
     */
    pasteClipboard() {
      if (!this.canPaste) return;
      EventBus.emit('paste_requested');
    },
    /**
     * Deletes the selection.
     *
     * @public
     */
    deleteSelection() {
      if (!this.hasSelection) return;
      EventBus.emit('delete_requested', Selection.items.map((entry) => ({ ...entry })));
    },
    /**
     * Switches the transform gizmo between its two tools.
     *
     * @public
     * @param {String} mode 'translate' or 'rotate'
     */
    setGizmoMode(mode) {
      this.modeTick += 1;
      this.gizmoMode = mode;
      this.$show.visualizerHandle.gizmoMode = mode;
    },
    /**
     * Follows a tool change the scene made on its own, from the keyboard.
     *
     * @public
     * @param {String} mode 'translate' or 'rotate'
     */
    setGizmoModeFromScene(mode) {
      this.gizmoMode = mode;
    },
    /**
     * Opens visualizer in a popup window
     *
     * @public
     */
    popout() {
      this.hide();
      this.popupHandle = window.open('/visualizer', 'visualizerWindow', 'popup');
      this.popupHandle.$show = this.$show;
      this.popupHandle.onbeforeunload = this.show;
    },
    /**
     * Toggles visualizer's visibility state on/off
     *
     * @public
     */
    toggleVisibility() {
      if (this.hidden) {
        this.show();
      } else {
        this.hide();
      }
      // Dirty trick but it should do for now.
      EventBus.emit('visualizer_visibility', !this.hidden);
    },
    /**
     * Toggles visualizer's visibility state off
     *
     * @public
     */
    hide() {
      this.hidden = true;
      this.$show.visualizerHandle.stopRender();
    },
    /**
     * Toggles visualizer's visibility state on
     *
     * @public
     */
    show() {
      this.hidden = false;
      if (this.popupHandle) {
        this.popupHandle.close();
        this.popupHandle = null;
      }
      this.$show.visualizerHandle.startRender();
      this.$nextTick(() => {
        this.$show.visualizerHandle.resize();
      });
    },
    /**
     * Toggle camera auto-rotation
     *
     * @param {Boolean} value
     * @public
     */
    toggleAutoRotation(value) {
      this.$show.visualizerHandle.autoRotate = value;
      if (!value) this.$show.visualizerHandle.recenter();
    },
    /**
     * Toggle highlighted item autofocus
     *
     * @param {Boolean} value
     * @public
     */
    /**
     * Turns gizmo snapping on or off. The spacing lives in the visualizer
     * preferences; this is the part worth reaching for mid-layout.
     *
     * @public
     * @param {Boolean} value new state
     */
    toggleSnap(value) {
      this.snapEnabled = value;
      this.$show.visualizerHandle.snapEnabled = value;
    },
    toggleAutoFocus(value) {
      this.$show.visualizerHandle.autoFocus = value;
    },
    /**
     * Swaps between the two global light settings.
     *
     * Not a dimmer: the scene keeps a brightness for the room lit and another
     * for it dark, and each is tuned in the visualizer preferences.
     *
     * @public
     * @param {Boolean} value new state
     */
    toggleHouseLights(value) {
      this.houseLights = value;
      this.$show.visualizerHandle.houseLights = value;
    },
    /**
     * Switches between the editor and the studio.
     *
     * A mode, not a panel: the studio takes over the widget bar at the bottom
     * of the window as well as the shape of the canvas, because filming and
     * editing want different controls in the same space.
     *
     * A take running when the studio is left stops itself -- the recording
     * widget watches for exactly this and closes its file in an orderly way,
     * rather than being unmounted with an encoder still going.
     *
     * @public
     */
    toggleStudio() {
      Studio.setActive(!Studio.state.active);
    },
    /**
     * Pins the canvas to the current frame and lens.
     *
     * @public
     */
    applyShot() {
      const handle = this.$show.visualizerHandle;
      if (handle) handle.beginRecordingFrame(Studio.shot);
    },
    /**
     * Moves the view to a camera's stored viewpoint.
     *
     * @public
     * @param {String} id camera id
     */
    applyCamera(id) {
      const handle = this.$show.visualizerHandle;
      const viewpoint = Studio.viewpointOf(id);
      if (handle && viewpoint) handle.viewpoint = viewpoint;
    },
    /**
     * Keeps the live camera's stored viewpoint level with the actual view.
     *
     * Polled rather than driven from `OrbitControls`' change event, which fires
     * per frame of a drag: this writes six numbers into a reactive store, and
     * at 60 Hz that re-renders the camera widget for every pixel of mouse
     * movement. Ten times a second is faster than the fields can be read.
     *
     * @public
     */
    startCameraSync() {
      this.stopCameraSync();
      this.cameraSyncHandle = setInterval(() => {
        const handle = this.$show.visualizerHandle;
        if (!handle) return;
        // Not while flying. The sync writes the live view into whichever camera
        // is active, and during a move the live view is somewhere between two
        // cameras -- left running it would overwrite the destination with the
        // trip, so every fly would drag that camera towards the one before it.
        if (handle.flying) return;
        // A locked camera keeps the framing it was locked at. The view still
        // moves -- orbiting is not disabled -- it simply stops being written
        // back, which is the difference between looking around and redoing the
        // shot.
        if (Studio.isCameraLocked(Studio.state.activeCameraId)) return;
        Studio.captureInto(Studio.state.activeCameraId, handle.viewpoint);
      }, CAMERA_SYNC_MS);
    },
    /**
     * @public
     */
    stopCameraSync() {
      clearInterval(this.cameraSyncHandle);
      this.cameraSyncHandle = null;
    },
  },
};
</script>

<style scoped>
#visualizer{
  cursor: grab;
}
/**
 * The letterbox, while the record widget is open.
 *
 * `#visualizer` rather than `.visualizer` on purpose: the class is on the panel
 * *and* the canvas, and it sizes both to 100% with `!important`. The id beats
 * that on specificity without touching the panel.
 *
 * The drawing buffer is already the recording's exact size -- see
 * `Visualizer.beginRecordingFrame`. This only decides how that buffer is
 * displayed, so what is on screen is the frame that is being recorded, whole,
 * rather than a stretched or cropped version of it.
 */
#visualizer.framed {
  width: auto !important;
  height: auto !important;
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: var(--record-aspect, 16 / 9);
  margin: auto;
  outline: 1px solid var(--primary-dark);
}
.visualizer {
  display: flex;
  height: 100% !important;
  width: 100% !important;
  outline: none;
  border-left: var(--primary-dark);
}
.visualizer.hidden {
  width: unset !important;
}
.visualizer.hidden h3 {
  writing-mode: vertical-lr;
  text-orientation: mixed;
  transform: scale(-1);
}
.header {
  display: flex;
  flex-direction: row;
  min-height: 40px;
  width: 100%;
  padding: 0 8px;
  align-items: center;
  border-bottom: 1px solid var(--primary-dark);
  background: var(--primary-light);
}
.tool_divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 4px;
  background: var(--primary-dark);
}
.visualizer.hidden .header {
  height: 100%;
  width: 40px;
  text-align: left;
  flex-direction: column-reverse;
  padding: 10px 0px;
}
</style>
