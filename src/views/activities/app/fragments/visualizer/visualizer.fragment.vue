<template>
  <div
    class="visualizer"
    :class="{ full_screen: view.fullScreen }"
  >
    <!-- In full screen the toolbar is tucked away above the view and comes
         down while the pointer is on this strip or on the toolbar itself. -->
    <div
      v-if="view.fullScreen"
      class="reveal"
    />
    <uk-flex
      class="header"
      gap="4"
    >
      <!-- Move, rotate, scale and measure: one tool at a time. -->
      <uk-button
        :key="`translate-${gizmoMode}-${measure.active}-${modeTick}`"
        square
        icon-only
        label="Move (T)"
        :value="false"
        toggleable
        :model-value="!measure.active && gizmoMode === 'translate'"
        icon="move"
        color="var(--accent-blue)"
        @click="setGizmoMode('translate')"
      />
      <uk-button
        :key="`rotate-${gizmoMode}-${measure.active}-${modeTick}`"
        square
        icon-only
        label="Rotate (R)"
        :value="false"
        toggleable
        :model-value="!measure.active && gizmoMode === 'rotate'"
        icon="rotate"
        color="var(--accent-blue)"
        @click="setGizmoMode('rotate')"
      />
      <uk-button
        :key="`scale-${gizmoMode}-${measure.active}-${modeTick}`"
        square
        icon-only
        label="Scale (S)"
        :value="false"
        toggleable
        :disabled="!canScale"
        :model-value="!measure.active && gizmoMode === 'scale'"
        icon="scale"
        color="var(--accent-blue)"
        @click="setGizmoMode('scale')"
      />
      <uk-button
        :key="`measure-${measure.active}-${modeTick}`"
        square
        icon-only
        label="Measure (M)"
        icon="ruler"
        :model-value="measure.active"
        toggleable
        :value="false"
        color="var(--accent-blue)"
        @click="toggleMeasure"
      />
      <div
        class="tool_divider"
      />
      <uk-button
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
      <view-filter />
      <uk-button
        square
        icon-only
        label="Fit to view"
        icon="fit"
        @click="$show.visualizerHandle.frameAll()"
      />
      <!-- Parallel projection, as a technical drawing's plan or elevation.
           Editing only: studio and recordings are perspective. -->
      <uk-button
        :key="`ortho-${orthographic}-${modeTick}`"
        square
        icon-only
        label="Orthographic"
        :value="false"
        toggleable
        :disabled="studioActive"
        :model-value="orthographic"
        icon="ortho"
        color="var(--accent-blue)"
        @click="toggleOrthographic"
      />
      <uk-button
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
        class="tool_divider"
      />
      <uk-button
        square
        icon-only
        label="Copy (Ctrl+C)"
        icon="copy"
        :disabled="!hasSelection"
        @click="copySelection"
      />
      <uk-button
        square
        icon-only
        label="Paste (Ctrl+V)"
        icon="paste"
        :disabled="!canPaste"
        @click="pasteClipboard"
      />
      <uk-button
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
        square
        :label="studioActive ? 'To Editor' : 'To Studio'"
        @click="toggleStudio"
      />
      <uk-button
        square
        icon-only
        :label="view.fullWindow ? 'Back to panels (F10)' : 'Full window (F10)'"
        icon="fit"
        :model-value="view.fullWindow"
        toggleable
        :value="false"
        color="var(--accent-blue)"
        @click="toggleFullWindow"
      />
    </uk-flex>

    <canvas
      id="visualizer"
      ref="visualizer"
      class="visualizer"
      :class="{ framed: studioActive }"
      :style="studioActive ? { '--record-aspect': studioAspect } : null"
    />
  </div>
</template>

<script>
import Visualizer from '@/plugins/visualizer/visualizer';
import EventBus from '@/plugins/eventbus';
import Clipboard from '@/models/DMX/clipboard';
import Selection from '@/models/DMX/selection';
import Studio from '@/models/DMX/studio';
import ViewMode from '@/plugins/view_mode';
import MeasureTool from '@/plugins/visualizer/measure_tool';
import ViewFilter from './view.filter.vue';

/**
 * How often the live camera's stored viewpoint is refreshed while orbiting.
 *
 * Fast enough that the position fields read as live, slow enough that a drag is
 * not writing to a reactive store sixty times a second.
 */
const CAMERA_SYNC_MS = 100;

export default {
  name: 'VisualizerFragment',
  components: { ViewFilter },
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  data() {
    return {
      /** Full window and full screen. */
      view: ViewMode.state,
      /**
       * handle to visualizer instance
       */
      visualizerHandle: null,
      /**
       * handle to popup window
       */
      /**
       * Visibility state
       */
      snapEnabled: true,
      /** The measure tool's state, for its button. */
      measure: MeasureTool.state,
      houseLights: true,
      /**
       * Which transform tool the gizmo is in: 'translate', 'rotate' or
       * 'scale'. Held
       * here rather than read straight off the visualizer so the buttons have
       * something reactive to light up from.
       */
      gizmoMode: 'translate',
      /** Whether the view is orthographic, mirrored for the button. */
      orthographic: false,
      /**
       * Bumped on every mode click, purely to re-key the two mode buttons.
       * uk-button flips its own toggle on click, so without a remount the
       * active tool un-highlights when it is clicked again.
       */
      modeTick: 0,
      /** Interval keeping the live camera level with the view. */
      cameraSyncHandle: null,
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
     * Whether the scale tool applies: the selection is one model from a
     * file. Fixtures, created shapes and several items together do not scale
     * by axis.
     *
     * @property {Boolean} canScale
     */
    canScale() {
      if (Selection.items.length !== 1) return false;
      const [entry] = Selection.items;
      if (entry.kind !== 'object') return false;
      const object = [...(this.$show.objects || [])].find((o) => o.uid === entry.uid);
      return !!(object && object.isScalable);
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
    /** @property {Number} studioReturns cuts and flies to the live camera */
    studioReturns() {
      return Studio.state.returns;
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
        // Studio is perspective.
        handle.orthographic = false;
        this.orthographic = false;
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

      // A fly only makes sense between two cameras -- arriving in studio mode
      // has nothing to travel from, so that still snaps.
      this.goToCamera(value, !!previous);
    },
    /**
     * Cutting or flying to the camera that is already live.
     *
     * Nothing changes camera, so the watcher above never runs. The view goes
     * back to the camera's stored framing -- for a locked camera that is the
     * shot it was locked at, whatever the view has done since.
     */
    studioReturns() {
      if (!this.studioActive) return;
      this.goToCamera(Studio.state.activeCameraId, true);
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
    // After the visualizer, which is what loads the preferences.
    ViewMode.start();
    // A show opened at launch got here first; its view waited for a camera.
    this.$show.visualizerReady();
    EventBus.emit('visualizer_loaded', true);
    this.snapEnabled = this.$show.visualizerHandle.snapEnabled;
    this.houseLights = this.$show.visualizerHandle.houseLights;
    this.gizmoMode = this.$show.visualizerHandle.gizmoMode;
    // T, R and S still switch tools, so the buttons follow the keys as well as
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
    toggleFullWindow() {
      ViewMode.toggleFullWindow();
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
     * Switches the transform gizmo between its tools. The scene may refuse
     * Scale for a selection that cannot take it, so the button shows what the
     * scene settled on.
     *
     * @public
     * @param {String} mode 'translate', 'rotate' or 'scale'
     */
    setGizmoMode(mode) {
      this.modeTick += 1;
      // A transform tool ends measuring: the four are one set.
      MeasureTool.toggle(false);
      this.$show.visualizerHandle.gizmoMode = mode;
      this.gizmoMode = this.$show.visualizerHandle.gizmoMode;
    },
    /**
     * Turns the measure tool on or off.
     *
     * @public
     */
    toggleMeasure() {
      this.modeTick += 1;
      MeasureTool.toggle();
    },
    /**
     * Follows a tool change the scene made on its own, from the keyboard.
     *
     * @public
     * @param {String} mode 'translate', 'rotate' or 'scale'
     */
    toggleOrthographic() {
      const handle = this.$show.visualizerHandle;
      if (!handle) return;
      this.modeTick += 1;
      handle.orthographic = !handle.orthographic;
      this.orthographic = handle.orthographic;
    },
    setGizmoModeFromScene(mode) {
      this.gizmoMode = mode;
    },
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
     * Makes the view a camera's, by a fly if the button pressed asked for one.
     *
     * @public
     * @param {String} id camera id
     * @param {Boolean} canFly whether there is a view to travel from
     */
    goToCamera(id, canFly) {
      const handle = this.$show.visualizerHandle;
      // Asked for per change, by the button that was pressed, rather than read
      // from a mode.
      const wantsFly = Studio.state.flyRequested;
      Studio.state.flyRequested = false;
      if (wantsFly && handle && canFly) {
        const camera = Studio.state.cameras.find((c) => c.id === id);
        handle.flyToViewpoint(Studio.viewpointOf(id), {
          seconds: Studio.state.transition.seconds,
          easing: 'inOut',
          fov: camera ? camera.fov : undefined,
        });
        return;
      }
      this.applyCamera(id);
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
  flex-direction: column;
  height: 100% !important;
  width: 100% !important;
  outline: none;
  border-left: var(--primary-dark);
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
.visualizer.full_screen {
  position: relative;
}
.full_screen .header {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  transform: translateY(-100%);
  transition: transform 0.15s ease;
}
.reveal {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  z-index: 21;
}
.reveal:hover + .header,
.full_screen .header:hover,
.full_screen .header:focus-within {
  transform: none;
}
.tool_divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 6px;
  background: var(--primary-dark);
}
</style>
