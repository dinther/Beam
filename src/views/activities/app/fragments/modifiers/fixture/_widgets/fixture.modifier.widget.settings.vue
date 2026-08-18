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
    </uk-flex>
  </uk-widget>
</template>

<script>
import { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';
import { MAX_SHADOW_CASTERS } from '@/plugins/visualizer/moving_head';

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
</style>
