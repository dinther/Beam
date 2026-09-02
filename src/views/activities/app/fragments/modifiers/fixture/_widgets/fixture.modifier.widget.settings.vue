<template>
  <uk-widget
    class="fixture_settings"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="fixture"
      :gap="8"
      col
      class="fixture_settings_body"
    >
      <uk-flex :gap="8">
        <uk-txt-input
          v-model.lazy="name"
          style="flex: 1"
          label="Name"
        />
      </uk-flex>
      <uk-flex :gap="8">
        <uk-num-input
          v-model.lazy="universe"
          style="width: 70px"
          class="field"
          label="Universe"
          :min="0"
          :max="32767"
        />
        <uk-num-input
          v-model.lazy="channel"
          style="width: 70px"
          class="field"
          label="Channel"
          :min="1"
          :max="512"
        />
        <uk-txt-input
          v-show="spanHint"
          :model-value="spanHint"
          readonly
          style="flex: 1"
          label="Spans"
        />
      </uk-flex>
      <uk-checkbox
        v-show="canSpan"
        v-model="universeAligned"
        label="Prevent cross universe pixels"
      />
      <uk-txt-input
        v-model="fixture.model"
        readonly
        label="Model"
      />
      <uk-select-input
        v-if="fixture.modeIndex != null"
        v-model="fixture.modeIndex"
        label="Mode"
        :options="fixture.modeNames"
      />
      <uk-checkbox
        v-if="canCastShadow"
        v-model="castsShadow"
        :disabled="shadowBudgetSpent"
        :label="shadowLabel"
      />

      <!-- A video device's own settings live here for the same reason the
           shadow tick above does: they belong to *this* placement, and a
           fixture's placement settings are what this widget is. The Model
           widget beside it is profile-scoped -- it speaks for every device of
           the model -- so a projector's throw *range* belongs there and its
           throw ratio belongs here. Every row shows whether or not a channel
           drives it: most projectors and most displays have no DMX at all,
           plenty have a couple of channels and nothing else, and the panel
           must not change shape between them. -->
      <template v-if="device">
        <!-- Optics only for a projector: a screen has no lens to zoom or
             shift. Everything below is shared, because a source, a dimmer and
             a blank mean the same thing to both. -->
        <template v-if="isProjector">
          <span class="section_label">Optics</span>
          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('zoom')"
              style="width: 92px"
              label="Throw ratio"
              :precision="2"
              :min="device.range.min"
              :max="device.range.max"
              :disabled="device.isDriven('zoom') || !device.zooms"
              @update:model-value="writeDevice('zoom', $event)"
            />
            <span class="hint">{{ throwHint }}</span>
            <span
              v-if="device.isDriven('zoom')"
              class="driven"
            >{{ drivenBy('zoom') }}</span>
          </uk-flex>

          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('shiftH')"
              style="width: 92px"
              label="Shift H %"
              :precision="1"
              :min="-device.shiftLimitH"
              :max="device.shiftLimitH"
              :disabled="device.isDriven('shiftH') || !device.shiftLimitH"
              @update:model-value="writeDevice('shiftH', $event)"
            />
            <uk-num-input
              :model-value="read('shiftV')"
              style="width: 92px"
              label="Shift V %"
              :precision="1"
              :min="-device.shiftLimitV"
              :max="device.shiftLimitV"
              :disabled="device.isDriven('shiftV') || !device.shiftLimitV"
              @update:model-value="writeDevice('shiftV', $event)"
            />
            <span
              v-if="device.isDriven('shiftH') || device.isDriven('shiftV')"
              class="driven"
            >DMX</span>
          </uk-flex>

          <!-- Per edge, because the end machine of an array ramps on its inner
               edge only: ramping both would fade the outside of the picture
               against nothing. No DMX, because a blend is set once when the rig
               is built and never ridden from a desk. -->
          <span class="section_label">Soft edge %</span>
          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('blendLeft')"
              style="width: 72px"
              label="Left"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendLeft', $event)"
            />
            <uk-num-input
              :model-value="read('blendRight')"
              style="width: 72px"
              label="Right"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendRight', $event)"
            />
            <uk-num-input
              :model-value="read('blendTop')"
              style="width: 72px"
              label="Top"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendTop', $event)"
            />
            <uk-num-input
              :model-value="read('blendBottom')"
              style="width: 72px"
              label="Bottom"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendBottom', $event)"
            />
          </uk-flex>
        </template>

        <span class="section_label">Output</span>
        <uk-flex
          :gap="8"
          class="row"
        >
          <uk-select-input
            :model-value="sourceIndex"
            style="flex: 1"
            label="Source"
            :options="sourceOptions"
            :disabled="device.isDriven('source')"
            @input="pickSource"
          />
          <span
            v-if="device.isDriven('source')"
            class="driven"
          >{{ drivenBy('source') }}</span>
        </uk-flex>

        <uk-flex
          :gap="8"
          class="row"
        >
          <uk-num-input
            :model-value="Math.round(read('dimmer') || 0)"
            style="width: 92px"
            label="Dimmer %"
            :precision="0"
            :min="0"
            :max="100"
            :disabled="device.isDriven('dimmer')"
            @update:model-value="writeDevice('dimmer', $event)"
          />
          <uk-checkbox
            :model-value="!!read('shutter')"
            :label="isProjector ? 'Shutter open' : 'Picture on'"
            :disabled="device.isDriven('shutter')"
            @update:model-value="writeDevice('shutter', $event)"
          />
          <span
            v-if="device.isDriven('dimmer') || device.isDriven('shutter')"
            class="driven"
          >DMX</span>
        </uk-flex>
      </template>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';
import { MAX_SHADOW_CASTERS } from '@/plugins/visualizer/moving_head';
import { imageSizeAt } from '@/models/DMX/generic/projector';
import { GENERIC_KINDS } from '@/models/DMX/generic/kinds';

export default {
  name: 'FixtureModifierWidgetSettings',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to fixture instance
     */
    fixture: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      /**
       * Widget header data
       */
      header: {
        title: 'Fixture Settings',
        icon: 'wrench',
      },
      /**
       * Bumped on every device write, to re-read the settings.
       *
       * They are a plain model, and DMX writes into them from outside Vue
       * entirely, so nothing here re-evaluates on its own. Same staleness the
       * video popup hit reading a frame's size off a class instance.
       */
      deviceRevision: 0,
    };
  },
  computed: {
    /**
     * Whether this fixture can cast a shadow at all. An emitter bar has no
     * beam behind which to cast one, so it is not offered the choice.
     *
     * @type {Boolean}
     */
    canCastShadow() {
      return !!(this.fixture && this.fixture.canCastShadow);
    },
    /**
     * This projector's placement settings, or null for anything else.
     *
     * @type {Object|null}
     */
    device() {
      return (this.fixture && this.fixture.device) || null;
    },
    /** A screen has no lens, so the Optics rows are a projector's alone. */
    isProjector() {
      return !!(this.fixture && this.fixture.deviceKind === GENERIC_KINDS.PROJECTOR);
    },
    /**
     * Everything the projector rows show, read in one place.
     *
     * Carrying `projectorRevision` in is what makes a write, or a channel
     * arriving, reach the screen -- see the data property for why.
     *
     * @type {Object|null}
     */
    deviceState() {
      const at = this.deviceRevision;
      const { device } = this;
      if (!device) return null;
      return {
        at,
        zoom: device.value('zoom'),
        shiftH: device.value('shiftH'),
        shiftV: device.value('shiftV'),
        dimmer: device.value('dimmer'),
        shutter: device.value('shutter'),
        source: device.value('source'),
      };
    },
    /** Every connector in the show, with an unbound entry at the top. */
    connectors() {
      return (this.$show && this.$show.videoConnectors) || [];
    },
    sourceOptions() {
      return ['— none —', ...this.connectors.map((c) => c.name)];
    },
    sourceIndex() {
      const value = this.read('source');
      if (value === null || value === undefined) return 0;
      // A channel names a connector by position, one-based, which is what makes
      // `Source Select = 1` read as the first one. A hand-set value is an id,
      // which survives connectors being reordered.
      if (this.device.isDriven('source') && this.device.hasLive('source')) {
        return Math.min(Math.max(value, 0), this.connectors.length);
      }
      const at = this.connectors.findIndex((c) => c.id === value);
      return at < 0 ? 0 : at + 1;
    },
    /**
     * What the picture comes to at a plausible throw -- the number that says
     * whether a zoom setting covers the thing it is aimed at.
     *
     * @type {String}
     */
    throwHint() {
      if (!this.device) return '';
      const params = this.fixture.OFLData.asls.projector;
      const at = imageSizeAt(5, this.read('zoom'), params);
      const size = `at 5 m ${at.width.toFixed(2)} × ${at.height.toFixed(2)} m`;
      if (!this.device.zooms) return `prime · ${size}`;
      return `${this.device.range.min} – ${this.device.range.max} · ${size}`;
    },
    /**
     * Whether this fixture's beam casts a shadow.
     *
     * Per fixture and off by default. Shadow maps come out of a small fixed
     * pool the whole scene shares -- around sixteen on a typical GPU, counting
     * everything else that samples a texture -- so this is a few fixtures'
     * worth of budget to spend where it reads, not a switch to leave on.
     *
     * @type {Boolean}
     */
    castsShadow: {
      get() {
        return !!(this.fixture && this.fixture.castsShadow);
      },
      set(state) {
        if (this.fixture) this.fixture.castsShadow = state;
      },
    },
    /**
     * How many fixtures in the show are casting shadows.
     *
     * @type {Number}
     */
    shadowCasters() {
      return this.$show.fixturePool.fixtures.filter((f) => f.castsShadow).length;
    },
    /**
     * Whether the budget is gone.
     *
     * A fixture that is already casting is never blocked -- that would be a
     * tick you could not untick -- so this only ever stops the next one.
     *
     * @type {Boolean}
     */
    shadowBudgetSpent() {
      return !this.castsShadow && this.shadowCasters >= MAX_SHADOW_CASTERS;
    },
    /**
     * The label carries the count, so the limit is visible before it is hit
     * rather than appearing as a checkbox that mysteriously will not tick.
     *
     * @type {String}
     */
    shadowLabel() {
      return `Casts shadows (${this.shadowCasters}/${MAX_SHADOW_CASTERS})`;
    },
    /**
     * Universe the fixture starts in. Setting it slides the fixture by whole
     * universes, keeping its channel.
     */
    /**
     * Fixture name, kept unique across the show. Typing a name already in use
     * gains a number rather than being refused, so renaming never fails.
     *
     * @type {String}
     */
    name: {
      get() {
        return this.fixture ? this.fixture.name : '';
      },
      set(value) {
        if (!this.fixture) return;
        this.fixture.name = this.$show.fixturePool.uniqueName(value, this.fixture.id);
      },
    },
    universe: {
      get() {
        return this.fixture ? this.fixture.universe : 0;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.universe = Math.max(0, Number(value));
        }
      },
    },
    /**
     * 1-based start channel within that universe. A fixture whose channels run
     * past 512 continues into the next universe.
     */
    channel: {
      get() {
        return this.fixture ? this.fixture.chStart + 1 : 1;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.chStart = Math.max(0, Number(value) - 1);
        }
      },
    },
    /**
     * Names the universe a fixture runs on into, when it crosses a boundary.
     * Empty for the ordinary case, so the field stays out of the way.
     */
    spanHint() {
      if (!this.fixture || !this.fixture.channels.length) return '';
      const endUniverse = Math.floor((this.fixture.addressStop - 1) / DMX_UNIVERSE_LENGTH);
      return endUniverse > this.fixture.universe ? `→ U${endUniverse}` : '';
    },
    /**
     * Whether the fixture skips the last two channels of each universe, so its
     * channels tile 510 to a universe rather than running over the boundary.
     */
    universeAligned: {
      get() {
        return this.fixture ? this.fixture.universeAligned : false;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.universeAligned = !!value;
        }
      },
    },
    /**
     * The skip changes nothing for a fixture too short to reach a boundary, so
     * the option stays hidden for the rest.
     */
    canSpan() {
      if (!this.fixture) return false;
      return this.fixture.chStart + this.fixture.channels.length > DMX_UNIVERSE_LENGTH;
    },
  },
  methods: {
    /**
     * One device attribute out of the snapshot.
     *
     * @public
     * @param {String} key attribute name
     * @returns {*}
     */
    read(key) {
      return this.deviceState ? this.deviceState[key] : null;
    },
    /**
     * The marker beside a driven row, and whether anything has arrived on it
     * yet -- a different question from whether a channel exists.
     *
     * @public
     * @param {String} key attribute name
     * @returns {String}
     */
    drivenBy(key) {
      if (!this.device) return '';
      return this.device.hasLive(key) ? 'DMX' : 'DMX · waiting';
    },
    /**
     * Writes a parked value and lets the renderer redraw the throw.
     *
     * @public
     * @param {String} key attribute name
     * @param {*} value
     */
    writeDevice(key, value) {
      if (!this.device) return;
      this.device.set(key, value);
      this.deviceRevision += 1;
      const model = this.fixture && this.fixture._3DModel;
      if (model && model.refresh) model.refresh();
    },
    /**
     * Binds this projector to a video connector, by id.
     *
     * @public
     * @param {Number} index into `sourceOptions`, nought being unbound
     */
    pickSource(index) {
      if (!this.device) return;
      const connector = index > 0 ? this.connectors[index - 1] : null;
      // Through `writeDevice` rather than writing here: that is the one path
      // that also tells the renderer to redraw, and picking a source without it
      // left a display black until some *other* field was touched. Two write
      // paths differing in what each remembered to do -- the exact shape that
      // has bitten this app before.
      this.writeDevice('source', connector ? connector.id : null);
    },
  },
};
</script>

<style scoped>
.fixture_settings {
  max-width: 230px;
  min-width: 230px;
}
.fixture_settings_body {
  height: 100%;
  width: 100%;
  overflow-y: auto;
  padding: 6px;
  max-width: 230px;
  min-width: 230px;
}
.empty_text {
  display: flex;
  flex: 1;
  flex-direction: row;
  align-items: center;
  color: var(--secondary-light);
  justify-content: center;
}

/* --- projector rows ---------------------------------------------------- */

/* Top, not centred: a row mixes a labelled field with a bare hint or a DMX
   marker, and centring floats the short ones half way down beside the tall
   ones. Every widget in this app lines its rows up at the top. */
.row {
  align-items: flex-start;
}
.section_label {
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
  border-bottom: 1px solid var(--primary-dark);
  padding-bottom: 4px;
}
.hint {
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
  margin: 0;
}
/* The marker that says a row is not yours to set. Teal rather than red: a
   channel owning a value is the normal state of a patched fixture, not a
   fault. */
.driven {
  font-family: Roboto-Medium, sans-serif;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--accent-teal);
  white-space: nowrap;
}
</style>
