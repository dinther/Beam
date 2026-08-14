<template>
  <uk-flex class="fixture_modifier">
    <model-widget
      v-show="selectedFixture && !selectedGroup"
      ref="model"
      :fixture="selectedFixture"
    />
    <fixture-settings-widget
      v-show="selectedFixture && !selectedGroup"
      ref="settings"
      :fixture="selectedFixture"
    />
    <position-tool-widget
      v-show="selectedFixture && !selectedGroup"
      ref="positionTool"
      :fixture="selectedFixture"
    />
    <group-widget
      v-show="selectedGroup"
      :group="selectedGroup"
    />
    <h3
      v-if="!selectedFixture && !selectedGroup"
      class="empty_text"
    >
      Nothing Selected
    </h3>
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';

import FixtureSettingsWidget from './_widgets/fixture.modifier.widget.settings.vue';
import PositionToolWidget from './_widgets/fixture.modifier.widget.position.tool.vue';
import ModelWidget from './_widgets/fixture.modifier.widget.model.vue';
import GroupWidget from '../group/group.modifier.widget.vue';

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
    GroupWidget,
  },
  data() {
    return {
      /**
       * Currently selected fixture
       */
      selectedFixture: null,
      /**
       * Currently selected group, when a group rather than a fixture is what
       * the patch bay routed to.
       */
      selectedGroup: null,
    };
  },
  watch: {
    '$route.query.fixtureId': function routeQueryFixtureIdWatcher(fixtureId) {
      this.selectFixture(fixtureId);
    },
    '$route.query.groupId': function routeQueryGroupIdWatcher(groupId) {
      this.selectGroup(groupId);
    },
  },
  mounted() {
    this.selectFixture(this.$route.query.fixtureId);
    this.selectGroup(this.$route.query.groupId);
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
     * Fetches the routed group from the show.
     *
     * @public
     * @param {Number} id group id
     */
    selectGroup(id) {
      if (id === undefined || id === null) {
        this.selectedGroup = null;
        return;
      }
      this.selectedGroup = this.$show.groups
        .find((group) => group.id === Number(id)) || null;
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
        this.selectedGroup = null;
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
