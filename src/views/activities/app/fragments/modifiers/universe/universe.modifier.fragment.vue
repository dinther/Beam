<template>
  <uk-flex class="universe_modifier">
    <universe-settings-widget v-model="universe" />
    <fixture-pool-widget
      :pool="universe.fixturePool"
      :action="{
        icon: 'new',
        text: 'add',
        callback: displayPatchPopup,
      }"
      :auto-select="selectedFixtureIndex"
      :highlight-ids="highlightedFixtureIds"
      @select="selectFixture"
      @delete="deleteFixtures"
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
    <patch-popup
      v-model="patchPopupDisplayState"
      :universe="universe"
    />
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import FixturePoolWidget from '../_widgets/modifier.widget.fixture.pool.vue';

import UniverseSettingsWidget from './_widgets/universe.modifier.widget.settings.vue';
import FixtureSettingsWidget from './_widgets/universe.modifier.widget.fixture.settings.vue';
import PositionToolWidget from './_widgets/universe.modifier.widget.fixture.position.tool.vue';
import PatchPopup from './_popups/universe.modifier.popup.patch.vue';

export default {
  name: 'UniverseModifierFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    UniverseSettingsWidget,
    FixturePoolWidget,
    FixtureSettingsWidget,
    PositionToolWidget,
    PatchPopup,
  },
  data() {
    return {
      /**
       * Handle to universe instance
       */
      universe: {},
      /**
       * Currently selected fixture
       */
      selectedFixture: null,
      /**
       * Patch popup display state
       */
      patchPopupDisplayState: false,
      /**
       * Index of the currently selected fixture in the universe's fixture pool.
       */
      selectedFixtureIndex: 0,
      /**
       * Ids of fixtures selected in the 3D view, mirrored into the list.
       */
      highlightedFixtureIds: [],
    };
  },
  watch: {
    '$route.query.fixtureId': function routeQueryFixtureIdWatcher(fixtureId) {
      this.selectFixture(fixtureId);
    },
    // TODO: feed method straight into watcher
    '$route.params.universeId': function routeParamsUniverseIdWatcher(universeId) {
      this.fetchUniverseData(universeId);
      this.selectedFixtureIndex = 0;
    },
  },
  mounted() {
    this.fetchUniverseData(0);
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
     * Fetches universe data
     *
     * @public
     */
    fetchUniverseData(id) {
      if (id !== undefined) {
        try {
          this.universe = this.$show.universePool.getFromId(id);
          this.selectFixture(0);
        } catch (err) {
          // The requested ID is not in the pool (stale route, renumbered show).
          // Fall back to the first available universe rather than a bare object:
          // a plain {} carries none of the Universe methods the widgets call.
          const [fallback] = this.$show.universePool.universes;
          if (fallback) {
            this.universe = fallback;
            this.selectFixture(0);
          } else {
            this.universe = {};
            this.selectedFixture = null;
          }
        }
      }
    },
    /**
     * Fetches selected fixture data
     *
     * @public
     */
    selectFixture(id) {
      if (id !== undefined) {
        try {
          this.selectedFixture = this.universe.fixturePool.getFromId(id || 0);
        } catch (err) {
          this.selectedFixture = null;
        }
      }
    },
    /**
     * Mirrors a selection made by clicking in the 3D view. Routing is the
     * channel the fixture pool list already watches, so pushing the fixture id
     * keeps the list, the settings widget and the position tool in step.
     *
     * @public
     * @param {Object} payload {universeId, fixtureId}, or null to clear
     */
    handleFixturePicked(payload) {
      if (!payload) {
        this.selectedFixture = null;
        this.highlightedFixtureIds = [];
        return;
      }
      this.highlightedFixtureIds = payload.selectedIds || [];
      const { universeId, fixtureId } = payload;
      // A multi-fixture selection names no primary: routing to one of them
      // would make the list call highlightSingle() and collapse the rest.
      if (fixtureId === undefined) return;
      const path = `/universe/${universeId}`;
      // Re-picking the fixture that is already routed to is a no-op push;
      // vue-router rejects it, and there is nothing to update anyway.
      this.$router.push({ path, query: { fixtureId } }).catch(() => {});
      if (this.universe && this.universe.id === universeId) {
        this.selectFixture(fixtureId);
      }
    },
    /**
     * Display the patch popup
     *
     * @public
     */
    displayPatchPopup() {
      this.patchPopupDisplayState = true;
    },
    handleFocus(state) {
      if (!state) {
        if (this.selectedFixture) {
          this.selectedFixture.highlightSingle(false, true);
        }
      }
    },
    /**
     * Deletes one or many fixtures from the universe's fixture list.
     *
     * @public
     * @param {Array} selectedFixtures Array of universe fixture objetcs to be deleted.
     */
    deleteFixtures(selectedFixtures) {
      selectedFixtures.forEach((fixture) => {
        this.$show.deleteFixture(fixture);
      });
      if (this.universe.fixturePool.fixtures.length) {
        // eslint-disable-next-line prefer-destructuring
        this.selectedFixture = this.universe.fixturePool.fixtures[0];
      } else {
        this.selectedFixture = null;
      }
      this.selectedFixtureIndex = 0;
    },
  },
};
</script>

<style scoped>
.universe_modifier {
  width: 100%;
  height: 100%;
}
</style>
