<template>
  <uk-flex class="fixture_modifier">
    <model-widget
      v-show="selectedFixture"
      ref="model"
      :fixture="selectedFixture"
    />
    <fixture-settings-widget
      v-show="selectedFixture"
      ref="settings"
      :fixture="selectedFixture"
    />
    <position-tool-widget
      v-show="selectedFixture"
      ref="positionTool"
      :fixture="selectedFixture"
    />
    <h3
      v-if="!selectedFixture"
      class="empty_text"
    >
      No Fixture Selected
    </h3>
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';

import FixtureSettingsWidget from './_widgets/fixture.modifier.widget.settings.vue';
import PositionToolWidget from './_widgets/fixture.modifier.widget.position.tool.vue';
import ModelWidget from './_widgets/fixture.modifier.widget.model.vue';

export default {
  name: 'FixtureModifierFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    ModelWidget,
    FixtureSettingsWidget,
    PositionToolWidget,
  },
  data() {
    return {
      /**
       * Currently selected fixture
       */
      selectedFixture: null,
    };
  },
  watch: {
    '$route.query.fixtureId': function routeQueryFixtureIdWatcher(fixtureId) {
      this.selectFixture(fixtureId);
    },
  },
  mounted() {
    this.selectFixture(this.$route.query.fixtureId);
    EventBus.on('fixture_picked', this.handleFixturePicked);
  },
  beforeUnmount() {
    EventBus.off('fixture_picked', this.handleFixturePicked);
    if (this.selectedFixture && this.selectedFixture.id) {
      this.selectedFixture.highlightSingle(false);
    }
  },
  methods: {
    /**
     * Fetches the routed fixture from the show-wide pool.
     *
     * @public
     * @param {Number} id fixture id
     */
    selectFixture(id) {
      if (id === undefined || id === null) {
        this.selectedFixture = null;
        return;
      }
      try {
        this.selectedFixture = this.$show.fixturePool.getFromId(Number(id));
      } catch (err) {
        this.selectedFixture = null;
      }
    },
    /**
     * Clears the widgets when the 3D view drops its selection. Selections that
     * name a fixture arrive through the route instead, which the patch bay
     * pushes.
     *
     * @public
     * @param {Object} payload selection payload, or null when cleared
     */
    handleFixturePicked(payload) {
      if (!payload) {
        this.selectedFixture = null;
      }
    },
  },
};
</script>

<style scoped>
.fixture_modifier {
  height: 100%;
  width: 100%;
  gap: 6px;
  padding: 6px;
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
