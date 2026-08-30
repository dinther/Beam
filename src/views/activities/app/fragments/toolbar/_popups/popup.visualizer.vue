<template>
  <uk-popup
    v-model="state"
    :on-cancel="resetInitialValues"
    :header="headerData"
    @submit="close"
    @input="update()"
  >
    <uk-flex
      v-if="$show.visualizerHandle"
      class="body"
      :gap="8"
      col
    >
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Fogging</h3>
        <p class="subtitle">
          Global scene fogging settings.
        </p>
      </uk-flex>

      <uk-flex center-h>
        <div>
          <h4>State:</h4>
          <p class="subtitle">
            Turn global scene fogging on/off
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          v-model="$show.visualizerHandle.globalFoggingState"
          :min="0"
          :max="100"
          style="width: 100px"
          :options="['disabled', 'enabled']"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Intensity:</h4>
          <p class="subtitle">
            How much haze there is. None leaves a clean beam.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.globalFoggingDensity"
          :min="0"
          :max="100"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Scale:</h4>
          <p class="subtitle">
            How wide one clump of haze is, in metres.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.globalFoggingScale"
          :min="2"
          :max="15"
          :precision="1"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Turbulence:</h4>
          <p class="subtitle">
            Sets fog turbulence behavior over time.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.globalFoggingTurbulences"
          :min="0"
          :max="100"
          style="width: 100px"
        />
      </uk-flex>
      <div class="separator" />
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Lighting</h3>
        <p class="subtitle">
          Lighting emulation settings.
        </p>
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>House lights up:</h4>
          <p class="subtitle">
            Brightness with the house lights on, for looking at the rig.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.houseLightsUp"
          :min="0"
          :max="200"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>House lights down:</h4>
          <p class="subtitle">
            Brightness with them off, for watching the show. The toolbar swaps
            between the two.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.houseLightsDown"
          :min="0"
          :max="200"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Room, house up:</h4>
          <p class="subtitle">
            The image lighting the room with the house lights on.
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          v-model="environmentUpIndex"
          style="width: 120px"
          :options="environmentOptions"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Room, show:</h4>
          <p class="subtitle">
            And with them off. A dark room still wants something in it, or
            metal and gloss have nothing to reflect.
          </p>
        </div>
        <uk-spacer />
        <uk-select-input
          v-model="environmentDownIndex"
          style="width: 120px"
          :options="environmentOptions"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Add a room:</h4>
          <p class="subtitle">
            Copies a .hdr or .exr into your library, where both lists read
            from.
          </p>
        </div>
        <uk-spacer />
        <uk-button
          label="Add..."
          style="width: 120px"
          @click="addEnvironment"
        />
      </uk-flex>
      <div class="separator" />
      <uk-flex
        :gap="8"
        col
        class="title"
      >
        <h3>Reference</h3>
        <p class="subtitle">
          Scene reference objects. Turn these off for a clean render.
        </p>
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Grid size:</h4>
          <p class="subtitle">
            Metres between grid lines, and the distance the gizmo snaps by.
            The same on all three axes.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.snapSpacing"
          :precision="2"
          :min="0.01"
          :max="100"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Grid:</h4>
          <p class="subtitle">
            Show the infinite reference grid.
          </p>
        </div>
        <uk-spacer />
        <uk-checkbox v-model="$show.visualizerHandle.showGrid" />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Grid brightness:</h4>
          <p class="subtitle">
            How strongly the grid draws. What reads as subtle depends on the
            background behind it, so it is worth setting once you have chosen
            one.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.gridOpacity"
          :precision="2"
          :min="0"
          :max="1"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Grid line width:</h4>
          <p class="subtitle">
            In pixels. Below 1 the lines go fainter rather than narrower --
            a line thinner than a pixel cannot be drawn, only dimmed.
          </p>
        </div>
        <uk-spacer />
        <uk-num-input
          v-model="$show.visualizerHandle.gridLineWidth"
          :precision="2"
          :min="0.1"
          :max="4"
          style="width: 100px"
        />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Axes:</h4>
          <p class="subtitle">
            Show the origin axis indicator.
          </p>
        </div>
        <uk-spacer />
        <uk-checkbox v-model="$show.visualizerHandle.showAxes" />
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Background:</h4>
          <p class="subtitle">
            Colour behind the scene.
          </p>
        </div>
        <uk-spacer />
        <input
          v-model="backgroundColor"
          type="color"
          class="colour_swatch"
        >
      </uk-flex>
      <uk-flex center-h>
        <div>
          <h4>Debug:</h4>
          <p class="subtitle">
            Show the frame timings and the emitter tuning panel.
          </p>
        </div>
        <uk-spacer />
        <uk-checkbox v-model="$show.visualizerHandle.debug" />
      </uk-flex>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';

export default {
  name: 'VisualizerPopup',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  mixins: [PopupMixin],
  data() {
    return {
      /**
       * Popup header data
       */
      headerData: { title: 'Visualizer settings' },
      /** Environment images in the library, as `{ key, name, url }`. */
      environments: [],
    };
  },
  computed: {
    /**
     * Every choice the two room lists offer.
     *
     * The two sentinels first, then whatever is in the library. A setting whose
     * file has since been deleted is appended rather than dropped: silently
     * showing the first entry instead would look like the setting had changed
     * itself.
     *
     * @type {Array}
     */
    environmentEntries() {
      const entries = [
        { key: 'room', name: 'Built-in room' },
        { key: 'venue', name: 'Dark venue' },
        { key: 'none', name: 'None' },
        ...this.environments,
      ];
      const handle = this.$show.visualizerHandle;
      if (handle) {
        [handle.environmentHouseOn, handle.environmentHouseOff].forEach((spec) => {
          if (spec && !entries.some((entry) => entry.key === spec)) {
            entries.push({ key: spec, name: `${spec} (missing)` });
          }
        });
      }
      return entries;
    },
    /** @type {Array<String>} what the selects display */
    environmentOptions() {
      return this.environmentEntries.map((entry) => entry.name);
    },
    /**
     * The house-up room, as the index the select works in.
     *
     * `uk-select-input` is an index, and the setting is a file name, so the two
     * are mapped here rather than storing an index -- an index would move under
     * the setting whenever the library gained or lost a file.
     *
     * @type {Number}
     */
    environmentUpIndex: {
      get() {
        return this.indexOfEnvironment(this.$show.visualizerHandle
          && this.$show.visualizerHandle.environmentHouseOn);
      },
      set(index) {
        const entry = this.environmentEntries[index];
        if (entry && this.$show.visualizerHandle) {
          this.$show.visualizerHandle.environmentHouseOn = entry.key;
        }
      },
    },
    /**
     * The show-time room, as the index the select works in.
     *
     * @type {Number}
     */
    environmentDownIndex: {
      get() {
        return this.indexOfEnvironment(this.$show.visualizerHandle
          && this.$show.visualizerHandle.environmentHouseOff);
      },
      set(index) {
        const entry = this.environmentEntries[index];
        if (entry && this.$show.visualizerHandle) {
          this.$show.visualizerHandle.environmentHouseOff = entry.key;
        }
      },
    },
    /**
     * Floor image, as the index the select works in.
     *
     * @type {Number}
     */
    /**
     * Scene background, as the hex string the colour input works in.
     *
     * @type {String}
     */
    backgroundColor: {
      get() {
        return this.$show.visualizerHandle
          ? this.$show.visualizerHandle.backgroundColor
          : '#0c0d0a';
      },
      set(value) {
        if (this.$show.visualizerHandle) {
          this.$show.visualizerHandle.backgroundColor = value;
        }
      },
    },
  },
  watch: {
    state(state) {
      // Re-read on every opening, not only the first. Kept once, Cancel undid
      // everything back to however the scene stood when the dialog was first
      // opened this session -- including changes from an earlier visit that
      // had already been accepted with OK.
      if (state && this.$show.visualizerHandle) {
        this.initialValues = this.$show.visualizerHandle.showData;
        // Re-read the folder on every opening: the user may have put a file in
        // it since, and the dialog is the only place that would show it.
        this.loadEnvironments();
      }
    },
  },
  methods: {
    /**
     * Where a named environment sits in the option list.
     *
     * @param {String} spec a file name, or one of the sentinels
     * @returns {Number} an index, falling back to the built-in room
     */
    indexOfEnvironment(spec) {
      const index = this.environmentEntries.findIndex((entry) => entry.key === spec);
      return index < 0 ? 0 : index;
    },
    /**
     * Reads the library's environment folder.
     *
     * @public
     * @async
     */
    async loadEnvironments() {
      if (!window.library || !window.library.environments) return;
      this.environments = await window.library.environments();
    },
    /**
     * Asks for a radiance image and copies it into the library.
     *
     * The copy is what lets a preference name a file rather than a path. The
     * new image is not selected for either state: which room it is meant to be
     * is the user's to say.
     *
     * @public
     * @async
     */
    async addEnvironment() {
      if (!window.library || !window.library.addEnvironment) return;
      const result = await window.library.addEnvironment();
      if (result && result.ok) await this.loadEnvironments();
    },
    /**
     * resets visualizer settings to initial values, prior to modifications
     *
       * @public
     */
    resetInitialValues() {
      this.$show.visualizerHandle.globalFoggingState = this.initialValues.globalFoggingState;
      this.$show.visualizerHandle.globalFoggingDensity = this.initialValues.globalFoggingDensity;
      this.$show.visualizerHandle.globalFoggingScale = this.initialValues.globalFoggingScale;
      // eslint-disable-next-line max-len
      this.$show.visualizerHandle.globalFoggingTurbulences = this.initialValues.globalFoggingTurbulences;
      this.$show.visualizerHandle.houseLightsUp = this.initialValues.globalBrightness;
      this.$show.visualizerHandle.houseLightsDown = this.initialValues.brightnessHouseOff;
      this.$show.visualizerHandle.snapSpacing = this.initialValues.snapSpacing;
      this.$show.visualizerHandle.showGrid = this.initialValues.showGrid;
      this.$show.visualizerHandle.gridOpacity = this.initialValues.gridOpacity;
      // eslint-disable-next-line max-len
      this.$show.visualizerHandle.gridLineWidth = this.initialValues.gridLineWidth;
      this.$show.visualizerHandle.showAxes = this.initialValues.showAxes;
      this.close();
    },
  },
};
</script>

<style scoped>
/* The kit has no colour input, so this is the native one with its chrome taken
   off: a swatch the same height as the selects beside it. */
.colour_swatch {
  width: 48px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--secondary-light);
  border-radius: 3px;
  background: none;
  cursor: pointer;
}
.colour_swatch::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.colour_swatch::-webkit-color-swatch {
  border: none;
  border-radius: 2px;
}
.body {
  padding: 10px;
  min-width: 400px;
  max-width: 400px;
  max-height: 40vh;
  overflow: auto;
}

.function_button {
  margin-top: 8px;
  margin-left: 8px;
}
.separator {
  margin: 4px 0;
  width: 100%;
}
.subtitle {
  font-family: Roboto-Regular;
  margin-bottom: 8px;
  color: var(--secondary-lighter-alt);
}
.title{
  border-bottom: 1px solid var(--primary-dark);
}
.title_icon {
  fill: var(--secondary-lighter);
}
h4 {
  margin-bottom: 4px;
}
</style>
