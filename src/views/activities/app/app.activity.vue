<template>
  <uk-flex
    col
    class="app_activity"
  >
    <toolbar />
    <uk-flex class="top_fragments">
      <uk-flex
        class="top_fragment_left"
        :style="{ width: `${leftWidth}px` }"
      >
        <patch-bay />
      </uk-flex>
      <div
        class="splitter splitter_vertical"
        @pointerdown="startDrag($event, 'left')"
      />
      <visualizer />
    </uk-flex>
    <div
      class="splitter splitter_horizontal"
      @pointerdown="startDrag($event, 'bottom')"
    />
    <div
      class="bottom_fragment"
      :style="{ height: `${bottomHeight}px` }"
    >
      <modifier />
    </div>
    <popup-splash
      v-model="splashState"
      :loader="loader"
      :dismissable="!loader.state"
    />
    <error-popup
      v-model="errPopup.state"
      style="z-index: 1000"
      :error="errPopup.error"
    />
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';

import Toolbar from './fragments/toolbar/toolbar.fragment.vue';
import PatchBay from './fragments/patch-bay/patch-bay.fragment.vue';
import Visualizer from './fragments/visualizer/visualizer.fragment.vue';
import Modifier from './fragments/modifiers/modifier.fragment.vue';

import PopupSplash from './_popups/popup.splash.vue';
import ErrorPopup from './_popups/popup.error.vue';
/**
 * Whether the splash is owed an appearance this launch.
 *
 * Answered by the main process through preload, because it cannot be answered
 * here: New Project and Open both end in `window.location.reload()`, which
 * re-evaluates this module. Anything kept at module scope -- as this was, on
 * the reasoning that a reload is a launch -- resets with it and puts the logo
 * back up on exactly the two actions that should not have it.
 *
 * Outside Electron there is no main process to ask, and a plain page load is
 * a launch, so the splash shows.
 */
const SPLASH_DUE = window.appSession ? !!window.appSession.splashDue : true;

/** Splitter limits, in px. */
const DEFAULT_LEFT_WIDTH = 200;
const MIN_LEFT_WIDTH = 120;
const MAX_LEFT_WIDTH = 600;
const DEFAULT_BOTTOM_HEIGHT = 260;
const MIN_BOTTOM_HEIGHT = 120;
const MIN_TOP_HEIGHT = 200;

export default {
  name: 'AppActivity',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    Toolbar,
    PatchBay,
    Visualizer,
    Modifier,
    PopupSplash,
    ErrorPopup,
  },
  data() {
    return {
      /**
       * Panel sizes in px, dragged by the splitters and remembered between
       * runs. Read once here so a fresh install still gets sane defaults.
       */
      leftWidth: Number(localStorage.getItem('layout.leftWidth')) || DEFAULT_LEFT_WIDTH,
      bottomHeight: Number(localStorage.getItem('layout.bottomHeight')) || DEFAULT_BOTTOM_HEIGHT,
      drag: null,
      /**
       * Error popup description object
       */
      errPopup: {
        error: new Error(),
        state: false,
      },
      /**
       * App readyness state
       */
      ready: false,
      /**
       * App loading state
       */
      loading: true,
      /**
       * Handle to show loading property
       */
      loader: this.$show.loading,
      /**
       * Whether the splash is up because the user asked to see it, rather
       * than because something is loading.
       */
      aboutOpen: false,
      /**
       * Whether the splash's loading turn is still to come. Spent at the end
       * of `setup`, so it covers the whole of the first load and nothing after.
       */
      splashDue: SPLASH_DUE,
      /** Drops the launched-with-a-project subscription on unmount. */
      stopListeningForDocuments: null,
    };
  },
  computed: {
    /**
     * Whether the splash is on screen, for either reason.
     *
     * Setting it only ever means dismissing, and a load is not the user's to
     * dismiss -- so a false lands on the About flag and leaves the loader
     * alone.
     *
     * The loading half is spent once. Starting a new project or opening one
     * runs the same load and raises the same `loading.state`, but that is not
     * the application starting and should not put the logo back on screen.
     * After the first load only About opens it.
     *
     * @type {Boolean}
     */
    splashState: {
      get() {
        return (this.loader.state && this.splashDue) || this.aboutOpen;
      },
      set(open) {
        if (!open) this.aboutOpen = false;
      },
    },
  },
  watch: {
    '$show.loading': {
      deep: true,
      handler(value) {
        this.loader = value;
      },
    },
  },
  async mounted() {
    this.$router._appReayState = false;
    EventBus.on('visualizer_loaded', this.setup);
    EventBus.on('app_error', this.handleAppError);
    EventBus.on('show_about', this.showAbout);
    // Someone double-clicked a project while Beam was already running.
    if (window.documentStore) {
      this.stopListeningForDocuments = window.documentStore.onRequested((target) => {
        this.$show.openDocumentAt(target);
      });
    }
  },
  /**
   * Drops the bus subscriptions. Without this a remount — a hot reload during
   * development, or any re-entry to this route — leaves the dead instance
   * subscribed, so the next 'visualizer_loaded' runs setup() once per stale
   * listener and the show is loaded several times over.
   */
  beforeUnmount() {
    EventBus.off('visualizer_loaded', this.setup);
    EventBus.off('app_error', this.handleAppError);
    EventBus.off('show_about', this.showAbout);
    if (this.stopListeningForDocuments) this.stopListeningForDocuments();
  },
  methods: {
    /**
     * Puts the splash up because the user asked for it.
     *
     * @public
     */
    showAbout() {
      this.aboutOpen = true;
    },
    /**
     * Surfaces a load error in the popup.
     *
     * @public
     * @param {Error} err the error to display
     */
    handleAppError(err) {
      this.loader.message = 'An error occured while loading the app...';
      this.errPopup.error = err;
      this.errPopup.state = true;
    },
    /**
     * Begins a splitter drag.
     *
     * @public
     * @param {Object} e pointerdown event on the splitter
     * @param {String} axis 'left' for the patch bay, 'bottom' for the modifier
     */
    startDrag(e, axis) {
      this.drag = {
        axis,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: this.leftWidth,
        startBottom: this.bottomHeight,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', this.onDrag);
      window.addEventListener('pointerup', this.endDrag);
    },
    /**
     * Resizes while the pointer is held.
     *
     * @public
     * @param {Object} e pointermove event
     */
    onDrag(e) {
      if (!this.drag) return;
      if (this.drag.axis === 'left') {
        const width = this.drag.startLeft + (e.clientX - this.drag.startX);
        this.leftWidth = Math.min(Math.max(width, MIN_LEFT_WIDTH), MAX_LEFT_WIDTH);
      } else {
        const height = this.drag.startBottom - (e.clientY - this.drag.startY);
        const max = window.innerHeight - MIN_TOP_HEIGHT;
        this.bottomHeight = Math.min(Math.max(height, MIN_BOTTOM_HEIGHT), max);
      }
    },
    /**
     * Ends the drag and remembers the size.
     *
     * @public
     */
    endDrag() {
      this.drag = null;
      window.removeEventListener('pointermove', this.onDrag);
      window.removeEventListener('pointerup', this.endDrag);
      localStorage.setItem('layout.leftWidth', this.leftWidth);
      localStorage.setItem('layout.bottomHeight', this.bottomHeight);
    },
    /**
     * Setup App. Loads show from local storage or creates new
     * show project if no local data is available
     *
     * @public
     */
    async setup() {
      // The app starts on a new, empty project. Nothing is restored, reopened
      // or guessed at: a document appears only when the user opens one.
      //
      // It used to restore a stored show, and separately remember which file
      // had been open. Those two could disagree -- the title said Propaganda
      // while the contents were an empty autosave -- and one click on Save
      // would then have written the empty show over a real project.
      try {
        const res = await fetch(`${import.meta.env.VITE_STATIC_URL}demo/showfiles/blank.showfile.json`);
        await this.$show.loadFromData(await res.json());
      } catch (err) {
        EventBus.emit('app_error', err);
      }

      // Raised again in the same tick the load lowered it, so the overlay
      // never blinks out between the two.
      this.loader = {
        message: 'Waiting for views to settle',
        percentage: 90,
        state: true,
      };
      await this.$router.push('/patch');

      await new Promise((r) => { setTimeout(r, 500); });
      this.loader.state = false;
      // Spent here rather than when the show load finished: the overlay is
      // deliberately raised again above to cover the view settling, and that
      // is still part of starting up. From this line on, a raised loader
      // belongs to a project the user asked for and shows no splash.
      this.splashDue = false;
      this.$router._appReayState = true;
      this.ready = true;
      EventBus.emit('app_ready');

      // Started by double-clicking a project: open it now that there is
      // something to open it with. Claimed rather than read, so a reload does
      // not reopen a file the user has since moved on from.
      if (window.documentStore) {
        const launchedWith = await window.documentStore.claimPending();
        if (launchedWith) await this.$show.openDocumentAt(launchedWith);
      }
    },
  },
};
</script>

<style>
.v-application--wrap {
  min-height: 100% !important;
  position: relative;
}
.v-main__wrap {
  overflow: hidden !important;
  position: relative;
}
</style>

<style scoped>
.app_activity{
  position: relative;
  height:100%;
  width: 100%;
}
.top_fragments {
  z-index: 10;
  overflow: hidden;
  /* Absorbs the leftover height; the modifier row below keeps its dragged size. */
  flex: 1;
  min-height: 0;
}
.bottom_fragment {
  display: flex;
  flex: none;
  overflow: hidden;
}
.top_fragment_left{
  flex: none;
  overflow: hidden;
}
.splitter {
  flex: none;
  background: var(--primary-dark);
  z-index: 30;
}
.splitter:hover,
.splitter:active {
  background: var(--accent-teal);
}
.splitter_vertical {
  width: 4px;
  cursor: col-resize;
}
.splitter_horizontal {
  height: 4px;
  width: 100%;
  cursor: row-resize;
}
.visualizer {
  height: 100% !important;
}
</style>
