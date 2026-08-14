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
      v-model="loader.state"
      :loader="loader"
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
    };
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
  },
  methods: {
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
      let localLoadingSucceeded = false;
      try {
        localLoadingSucceeded = await this.$show.loadPersisted();
      } catch (err) {
        // A stored show that will not load is still the user's work. Fall
        // through to the demo so the app comes up, but leave the file alone.
        EventBus.emit('app_error', err);
      }

      if (!localLoadingSucceeded) {
        const res = await fetch(`${import.meta.env.VITE_STATIC_URL}demo/showfiles/demo.showfile.json`);
        const showData = await res.json();
        // persist: false — the demo must never be written over a stored show.
        await this.$show.loadFromData(showData, { persist: false });
      }

      await this.$router.push('/patch');
      this.loader = {
        message: 'Waiting for views to settle',
        percentage: 90,
        state: true,
      };

      await new Promise((r) => { setTimeout(r, 500); });
      this.loader.state = false;
      this.$router._appReayState = true;
      this.ready = true;
      EventBus.emit('app_ready');
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
