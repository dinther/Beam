<template>
  <uk-popup
    v-model="state"
    cancelable
    :valid="valid"
    :header="headerData"
    @submit="create"
  >
    <uk-flex
      col
      :gap="8"
      class="create_form"
    >
      <uk-flex :gap="8">
        <uk-select-input
          v-model="kindIndex"
          style="width: 140px"
          label="Type"
          :options="kinds"
        />
        <uk-txt-input
          v-model="manufacturer"
          style="flex: 1"
          label="Manufacturer"
        />
        <uk-txt-input
          v-model="model"
          style="flex: 1"
          label="Model"
        />
      </uk-flex>

      <p
        v-if="nameTaken"
        class="create_warning"
      >
        {{ manufacturer }} / {{ model }} already exists. Pick another name.
      </p>

      <span class="create_section">Body (mm)</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="length"
          class="field"
          label="Length"
          :min="1"
          :max="20000"
        />
        <uk-num-input
          v-model="width"
          class="field"
          label="Width"
          :min="1"
          :max="2000"
        />
        <uk-num-input
          v-model="height"
          class="field"
          label="Height"
          :min="1"
          :max="2000"
        />
      </uk-flex>

      <span class="create_section">Pixels</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="columns"
          class="field"
          label="Columns"
          :min="1"
          :max="2000"
        />
        <uk-num-input
          v-model="rows"
          class="field"
          label="Rows"
          :min="1"
          :max="200"
        />
        <uk-num-input
          v-model="marginEnds"
          class="field"
          label="Margin L/R"
          :min="0"
          :max="10000"
        />
        <uk-num-input
          v-model="marginSides"
          class="field"
          label="Margin T/B"
          :min="0"
          :max="1000"
        />
      </uk-flex>

      <span class="create_section">Emitters</span>
      <uk-flex :gap="8">
        <uk-num-input
          v-model="emitterSize"
          class="field"
          label="Size (mm)"
          :min="1"
          :max="100"
        />
        <uk-num-input
          v-model="beamAngle"
          class="field"
          label="Beam °"
          :min="10"
          :max="180"
        />
        <uk-select-input
          v-model="orderIndex"
          style="width: 110px"
          label="Wire order"
          :options="orders"
        />
      </uk-flex>

      <span class="create_section">Scan</span>
      <uk-flex :gap="8">
        <uk-select-input
          v-model="startCornerIndex"
          style="width: 150px"
          label="Starts at"
          :options="corners"
        />
        <uk-select-input
          v-model="scanAxisIndex"
          style="width: 130px"
          label="Runs along"
          :options="axes"
        />
        <uk-checkbox
          v-model="serpentine"
          label="Serpentine"
        />
      </uk-flex>

      <p class="create_summary">
        {{ pixelCount }} pixels &middot; {{ channelCount }} channels &middot;
        {{ pitchHint }}
      </p>
    </uk-flex>
  </uk-popup>
</template>

<script>
import {
  DEFAULT_BAR_PARAMS, START_CORNERS, SCAN_AXES,
} from '@/models/DMX/generic/led_bar';

/** Millimetres per metre: the form talks mm, the model talks metres. */
const MM = 1000;

/**
 * Option lists.
 *
 * uk-select-input models the selected *index*, not the value, so each of these
 * is paired with an index in data and read back through a computed.
 */
const KINDS = ['LED bar'];
const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR', 'RGBW', 'GRBW', 'BGRW', 'RGBA', 'GRBA'];
const CORNERS = Object.values(START_CORNERS);
const AXES = Object.values(SCAN_AXES);

export default {
  name: 'CreateFixturePopup',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue', 'created'],
  data() {
    return {
      headerData: { title: 'Create generic fixture' },
      kindIndex: 0,
      kinds: KINDS,
      manufacturer: 'ASLS',
      model: 'LED Bar',
      length: DEFAULT_BAR_PARAMS.length * MM,
      width: DEFAULT_BAR_PARAMS.width * MM,
      height: DEFAULT_BAR_PARAMS.height * MM,
      marginEnds: DEFAULT_BAR_PARAMS.marginEnds * MM,
      marginSides: DEFAULT_BAR_PARAMS.marginSides * MM,
      columns: DEFAULT_BAR_PARAMS.columns,
      rows: DEFAULT_BAR_PARAMS.rows,
      emitterSize: DEFAULT_BAR_PARAMS.emitterSize * MM,
      beamAngle: DEFAULT_BAR_PARAMS.beamAngle,
      orderIndex: Math.max(ORDERS.indexOf(DEFAULT_BAR_PARAMS.order), 0),
      orders: ORDERS,
      startCornerIndex: Math.max(CORNERS.indexOf(DEFAULT_BAR_PARAMS.startCorner), 0),
      corners: CORNERS,
      scanAxisIndex: Math.max(AXES.indexOf(DEFAULT_BAR_PARAMS.scanAxis), 0),
      axes: AXES,
      serpentine: DEFAULT_BAR_PARAMS.serpentine,
    };
  },
  computed: {
    /**
     * Selected values, resolved from the indices the select components model.
     */
    order() {
      return ORDERS[this.orderIndex] || ORDERS[0];
    },
    startCorner() {
      return CORNERS[this.startCornerIndex] || CORNERS[0];
    },
    scanAxis() {
      return AXES[this.scanAxisIndex] || AXES[0];
    },
    state: {
      get() {
        return this.modelValue;
      },
      set(value) {
        this.$emit('update:modelValue', value);
      },
    },
    pixelCount() {
      return Math.max(1, this.columns) * Math.max(1, this.rows);
    },
    channelCount() {
      return this.pixelCount * this.order.length;
    },
    /**
     * Spacing between adjacent pixels, which the margins and count imply
     * rather than the user setting it.
     *
     * @type {String}
     */
    pitchHint() {
      if (this.columns < 2) return 'single column';
      const span = this.length - this.marginEnds * 2;
      if (span <= 0) return 'margins exceed the length';
      return `${(span / (this.columns - 1)).toFixed(1)} mm pitch`;
    },
    nameTaken() {
      const key = `${this.manufacturer.trim()}/${this.model.trim()}`;
      return !!this.$show.generatedProfiles[key];
    },
    valid() {
      return !!this.manufacturer.trim()
        && !!this.model.trim()
        && !this.nameTaken
        && this.length > this.marginEnds * 2
        && this.channelCount > 0;
    },
  },
  methods: {
    /**
     * Builds the profile and hands it to the show, which owns the library.
     *
     * @public
     */
    async create() {
      const key = await this.$show.createGeneratedProfile(
        this.manufacturer.trim(),
        this.model.trim(),
        {
          length: this.length / MM,
          width: this.width / MM,
          height: this.height / MM,
          marginEnds: this.marginEnds / MM,
          marginSides: this.marginSides / MM,
          columns: this.columns,
          rows: this.rows,
          emitterSize: this.emitterSize / MM,
          beamAngle: this.beamAngle,
          order: this.order,
          startCorner: this.startCorner,
          scanAxis: this.scanAxis,
          serpentine: this.serpentine,
        },
      );
      this.state = false;
      this.$emit('created', key);
    },
  },
};
</script>

<style scoped>
.create_form {
  padding: 12px;
  min-width: 560px;
}
.create_section {
  font-family: Roboto-Medium;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
  border-bottom: 1px solid var(--primary-dark);
  padding-bottom: 4px;
}
.create_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
  margin: 0;
}
.create_warning {
  font-family: Roboto-Medium;
  font-size: 11px;
  color: var(--accent-maroon);
  margin: 0;
}
.field {
  width: 90px;
}
</style>
