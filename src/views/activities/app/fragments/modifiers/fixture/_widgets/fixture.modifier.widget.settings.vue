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
          v-model.lazy="fixture.name"
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
    </uk-flex>
  </uk-widget>
</template>

<script>
import { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';

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
     * Universe the fixture starts in. Setting it slides the fixture by whole
     * universes, keeping its channel.
     */
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
  },
};
</script>

<style scoped>
.fixture_settings {
  max-width: 200px;
  min-width: 200px;
}
.fixture_settings_body {
  height: 100%;
  width: 100%;
  padding: 10px;
  max-width: 200px;
  min-width: 200px;
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
