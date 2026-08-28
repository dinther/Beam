<template>
  <uk-popup
    v-model="state"
    cancelable
    backdrop
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
        <!-- auto-update, because these two decide whether the name is taken
             and whether Create is allowed. Left to emit on blur, the warning
             described the previous name while the box showed the new one:
             type a unique model over a taken one and it still insisted the
             name existed until focus moved. -->
        <uk-txt-input
          v-model="manufacturer"
          auto-update
          style="flex: 1"
          label="Manufacturer"
        />
        <uk-txt-input
          v-model="model"
          auto-update
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
          :max="2000"
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
        <!-- Tenths, because emitters are small: a 3535 package is 3.5 mm and
             whole millimetres cannot say so. The steppers move by 0.1 to
             match, since they step one unit of the precision. -->
        <uk-num-input
          v-model="emitterSize"
          class="field"
          label="Size (mm)"
          :precision="1"
          :min="0.1"
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
        <uk-checkbox
          v-model="universeAligned"
          label="Prevent cross universe pixels"
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
  DEFAULT_BAR_PARAMS, START_CORNERS, SCAN_AXES, BAR_SHAPES,
} from '@/models/DMX/generic/led_bar';

/** Millimetres per metre: the form talks mm, the model talks metres. */
const MM = 1000;

/**
 * Option lists.
 *
 * uk-select-input models the selected *index*, not the value, so each of these
 * is paired with an index in data and read back through a computed.
 */
// What the thing is, which decides how other tools are told to draw it: a bar
// is a line with a thickness, a panel a rectangle. Separate from how many rows
// it carries -- a four-row batten is still a bar.
const KINDS = ['LED bar', 'LED panel'];
const KIND_SHAPES = [BAR_SHAPES.BAR, BAR_SHAPES.PANEL];
// The model name each kind starts out with. Changing the type renames the
// fixture to match, so the two do not sit there disagreeing -- but only while
// the name is still the one this dialog chose.
const KIND_NAMES = ['LED Bar', 'LED Panel'];
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
      manufacturer: 'Beatline',
      model: KIND_NAMES[0],
      // The last name this dialog wrote into the field. Held as a value rather
      // than as a plain "edited" flag because the dialog renames the fixture
      // itself -- on opening, and now on changing the type -- and its own
      // writes must not read as the user taking the name over.
      autoModel: KIND_NAMES[0],
      modelEdited: false,
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
      universeAligned: DEFAULT_BAR_PARAMS.universeAligned,
    };
  },
  computed: {
    /**
     * Selected values, resolved from the indices the select components model.
     */
    order() {
      return ORDERS[this.orderIndex] || ORDERS[0];
    },
    shape() {
      return KIND_SHAPES[this.kindIndex] || KIND_SHAPES[0];
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
  watch: {
    /**
     * Keeps the name with the type, until the user has an opinion about it.
     */
    kindIndex(index) {
      if (this.modelEdited) return;
      this.setModel(this.freeName(KIND_NAMES[index] || KIND_NAMES[0]));
    },
    /**
     * Notices the user taking the name over.
     *
     * Everything this dialog writes goes through `setModel`, which records it
     * first -- so a value that does not match is one the user typed.
     */
    model(value) {
      if (value !== this.autoModel) this.modelEdited = true;
    },
    state(open) {
      // No `update()` here, unlike the object dialog: this component does not
      // use PopupMixin. Its `state` is a computed whose setter emits
      // `update:modelValue` directly, so the parent is already in step and
      // there is nothing to forward -- and `this.update` does not exist.
      //
      // The dialog keeps its geometry between visits on purpose -- one bar is
      // usually followed by a variant of it -- but the name of the thing just
      // created is taken by definition, so reopening met a warning about a
      // name the user had not typed. Numbering it is what the rest of the app
      // does when a name collides.
      if (open) this.setModel(this.freeName());
    },
  },
  methods: {
    /**
     * Writes the model name as this dialog's own choice.
     *
     * Recording it before writing is what lets `model`'s watcher tell a
     * rename from here apart from one the user typed.
     *
     * @public
     * @param {String} name
     */
    setModel(name) {
      this.autoModel = name;
      this.model = name;
    },
    /**
     * A name, or the nearest free numbering of it.
     *
     * @public
     * @param {String} [from] the name to start from; the current one by default
     * @returns {String} a name no profile of this manufacturer is using
     */
    freeName(from = this.model) {
      const maker = this.manufacturer.trim();
      const wanted = (from || '').trim() || KIND_NAMES[0];
      const taken = (name) => !!this.$show.generatedProfiles[`${maker}/${name}`];
      if (!taken(wanted)) return wanted;
      // A trailing number is stripped first, so opening the dialog five times
      // gives "LED Bar 5" rather than "LED Bar 2 2 2 2".
      const base = wanted.replace(/\s+\d+$/, '');
      let n = 2;
      while (taken(`${base} ${n}`)) n += 1;
      return `${base} ${n}`;
    },
    /**
     * Builds the profile and hands it to the show, which owns the library.
     *
     * @public
     */
    async create() {
      // Closed before the profile is written, not after. Writing it makes the
      // name in these very fields taken, so the duplicate warning appeared for
      // the thing being created -- a red line and a jump as the dialog grew,
      // in the instant before it went away.
      this.state = false;
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
          universeAligned: this.universeAligned,
          shape: this.shape,
        },
      );
      // `state` is a computed over the parent's v-model, and its setter above
      // is what announces the change -- this dialog has no popup mixin and so
      // no close(). Calling one threw after the profile had been written,
      // leaving the dialog open holding the name it had just taken.
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
