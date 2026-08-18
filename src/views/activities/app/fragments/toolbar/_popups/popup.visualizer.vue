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
          <h4>Density:</h4>
          <p class="subtitle">
            Sets the global scene fog density amount.
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
          v-model="houseLightsUp"
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
          v-model="houseLightsDown"
          :min="0"
          :max="200"
          style="width: 100px"
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
          <h4>Floor:</h4>
          <p class="subtitle">
            Show the checkered ground plane.
          </p>
        </div>
        <uk-spacer />
        <uk-checkbox v-model="$show.visualizerHandle.showFloor" />
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
import Preferences from '@/plugins/visualizer/preferences';

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
    };
  },
  computed: {
    /**
     * Brightness with the house lights up.
     *
     * Both settings are stored, but only the one in force is on the light --
     * so editing the other writes the preference and leaves the scene alone,
     * and editing the live one goes through the visualizer so the scene
     * follows immediately.
     *
     * @type {Number}
     */
    houseLightsUp: {
      get() {
        return Preferences.get('globalBrightness');
      },
      set(value) {
        if (this.houseLights) {
          this.$show.visualizerHandle.globalBrightness = value;
          return;
        }
        Preferences.set('globalBrightness', Number(value));
      },
    },
    /**
     * Brightness with the house lights down.
     *
     * @type {Number}
     */
    houseLightsDown: {
      get() {
        return Preferences.get('brightnessHouseOff');
      },
      set(value) {
        if (!this.houseLights) {
          this.$show.visualizerHandle.globalBrightness = value;
          return;
        }
        Preferences.set('brightnessHouseOff', Number(value));
      },
    },
    /**
     * Which of the two is in force.
     *
     * @type {Boolean}
     */
    houseLights() {
      const visualizer = this.$show.visualizerHandle;
      return visualizer ? visualizer.houseLights : true;
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
      if (state && !this.initialValues && this.$show.visualizerHandle) {
        this.initialValues = this.$show.visualizerHandle.showData;
      }
    },
  },
  mounted() {
    if (!this.initialValues && this.$show.visualizerHandle) {
      this.initialValues = this.$show.visualizerHandle.showData;
    }
  },
  methods: {
    /**
     * resets visualizer settings to initial values, prior to modifications
     *
       * @public
     */
    resetInitialValues() {
      this.$show.visualizerHandle.globalFoggingState = this.initialValues.globalFoggingState;
      this.$show.visualizerHandle.globalFoggingDensity = this.initialValues.globalFoggingDensity;
      // eslint-disable-next-line max-len
      this.$show.visualizerHandle.globalFoggingTurbulences = this.initialValues.globalFoggingTurbulences;
      // Whichever room is in force is the one the live brightness belongs to,
      // so it is restored through the visualizer; the other is just a stored
      // number and goes straight back.
      this.$show.visualizerHandle.globalBrightness = this.houseLights
        ? this.initialValues.globalBrightness
        : this.initialValues.brightnessHouseOff;
      const storedKey = this.houseLights ? 'brightnessHouseOff' : 'globalBrightness';
      const storedValue = this.houseLights
        ? this.initialValues.brightnessHouseOff
        : this.initialValues.globalBrightness;
      Preferences.set(storedKey, storedValue);
      this.$show.visualizerHandle.showFloor = this.initialValues.showFloor;
      this.$show.visualizerHandle.showGrid = this.initialValues.showGrid;
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
