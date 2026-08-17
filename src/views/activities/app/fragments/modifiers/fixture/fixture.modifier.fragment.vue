<template>
  <uk-flex class="fixture_modifier">
    <model-widget
      v-show="showsOneFixture"
      ref="model"
      :fixture="selectedFixture"
    />
    <fixture-settings-widget
      v-show="showsOneFixture"
      ref="settings"
      :fixture="selectedFixture"
    />
    <position-tool-widget
      v-show="showsOneFixture"
      ref="positionTool"
      :fixture="selectedFixture"
    />
    <group-widget
      v-show="selectedGroup"
      :group="selectedGroup"
    />
    <arrange-widget
      v-if="showsManyFixtures"
      :fixtures="selectedFixtures"
    />
    <h3
      v-if="!showsOneFixture && !showsManyFixtures && !selectedGroup"
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
import ArrangeWidget from './_widgets/fixture.modifier.widget.arrange.vue';
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
    ArrangeWidget,
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
      /**
       * Every fixture in the current selection, primary included.
       *
       * The single-fixture widgets edit `selectedFixture` and always will --
       * there is no sensible "set the model of five fixtures at once". This is
       * for the tools that act on a whole selection.
       */
      selectedFixtures: [],
    };
  },
  computed: {
    /**
     * Whether the single-fixture widgets should be showing.
     *
     * A multi-selection used to leave them up, editing whichever fixture had
     * been clicked first while the gizmo held five -- so a nudge in the
     * position tool moved one fixture out of a set that looked selected.
     *
     * @property {Boolean} showsOneFixture
     */
    showsOneFixture() {
      return !!this.selectedFixture && !this.selectedGroup && this.selectedFixtures.length <= 1;
    },
    /**
     * Whether a selection of two or more fixtures is live.
     *
     * @property {Boolean} showsManyFixtures
     */
    showsManyFixtures() {
      return !this.selectedGroup && this.selectedFixtures.length > 1;
    },
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
        // The route naming no fixture means no fixture selection, and the set
        // has to follow. Picking a group routes through here on its way past,
        // and it clears the 3D highlighting without announcing -- so leaving
        // the set alone would strand it, and dropping the group again would
        // bring back a selection of fixtures that are no longer selected.
        this.selectedFixtures = [];
        return;
      }
      try {
        this.selectedFixture = this.$show.fixturePool.getFromId(Number(id));
        // Routing to one fixture *is* a selection of one. Without this a click
        // in the patch bay list would leave a stale multi-selection standing
        // and the single-fixture widgets hidden behind it.
        this.selectedFixtures = [this.selectedFixture];
      } catch (err) {
        this.selectedFixture = null;
        this.selectedFixtures = [];
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
     * Follows the selection made anywhere else -- the 3D view or the patch bay
     * list, both of which announce through this one event.
     *
     * Which fixture the single-fixture widgets edit still arrives through the
     * route, pushed by the patch bay; a selection of several names no primary,
     * so there is nothing to route to and only the set changes here.
     *
     * @public
     * @param {Object} payload {fixtureId, selectedIds}, or null when cleared
     */
    handleFixturePicked(payload) {
      if (!payload) {
        this.selectedFixture = null;
        this.selectedGroup = null;
        this.selectedFixtures = [];
        return;
      }
      // findFromId rather than getFromId: a selection is allowed to name a
      // fixture that has since been deleted, and that is not worth throwing
      // over.
      this.selectedFixtures = (payload.selectedIds || [])
        .map((id) => this.$show.fixturePool.findFromId(id))
        .filter(Boolean);
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
