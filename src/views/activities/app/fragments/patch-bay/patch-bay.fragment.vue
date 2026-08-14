<template>
  <div class="patch_bay">
    <div class="patch_bay_header">
      <h3>Patch Bay</h3>
      <span style="flex: 1" />
      <uk-button
        icon="new"
        style="margin-right: 8px"
        label="new"
        @click="displayPatchPopup"
      />
    </div>
    <uk-list
      deletable
      colored
      auto-select-first
      class="patch_bay_fixture_list"
      filterable
      :items="pool.listable"
      :highlight-ids="highlightedFixtureIds"
      @select="displayFixture"
      @highlight="highlightFixtures"
      @delete="deleteFixtures"
    />
    <patch-popup v-model="patchPopupDisplayState" />
  </div>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import PatchPopup from './_popups/popup.patch.vue';

export default {
  name: 'PatchBayFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    PatchPopup,
  },
  data() {
    return {
      /**
       * Every fixture in the show. Universes are an addressing detail now, not
       * a level in this list.
       */
      pool: this.$show.fixturePool,
      patchPopupDisplayState: false,
      /**
       * Ids of fixtures selected in the 3D view, mirrored into the list.
       */
      highlightedFixtureIds: [],
    };
  },
  mounted() {
    EventBus.on('fixture_picked', this.handleFixturePicked);
  },
  beforeUnmount() {
    EventBus.off('fixture_picked', this.handleFixturePicked);
  },
  methods: {
    /**
     * Routes to the selected fixture, which the modifier follows.
     *
     * @public
     * @param {Object} fixtureData listable entry of the selected fixture
     */
    displayFixture(fixtureData) {
      if (fixtureData) {
        this.$router.push({ path: '/patch', query: { fixtureId: fixtureData.id } }).catch(() => {});
      }
    },
    /**
     * Mirrors a list multi-selection into the 3D view.
     *
     * @public
     * @param {Array} fixtures listable entries of the highlighted fixtures
     */
    highlightFixtures(fixtures) {
      if (!fixtures.length) return;
      fixtures.forEach((fixtureData, index) => {
        const fixture = this.pool.getFromId(fixtureData.id);
        if (!fixture) return;
        if (index === 0) {
          fixture.highlightSingle(false, false);
        }
        fixture.highlight(true, true);
      });
    },
    /**
     * Deletes the highlighted fixtures from the show.
     *
     * @public
     * @param {Array} fixtures listable entries of the fixtures to delete
     */
    deleteFixtures(fixtures) {
      fixtures.forEach((fixtureData) => this.$show.deleteFixture(fixtureData));
    },
    /**
     * Reflects a selection made in the 3D view.
     *
     * @public
     * @param {Object} payload {fixtureId, selectedIds}, or null to clear
     */
    handleFixturePicked(payload) {
      if (!payload) {
        this.highlightedFixtureIds = [];
        return;
      }
      this.highlightedFixtureIds = payload.selectedIds || [];
      if (payload.fixtureId === undefined) return;
      this.$router.push({ path: '/patch', query: { fixtureId: payload.fixtureId } }).catch(() => {});
    },
    /**
     * Displays the patch popup
     *
     * @public
     */
    displayPatchPopup() {
      this.patchPopupDisplayState = true;
    },
  },
};
</script>

<style scoped>
.patch_bay{
  background: var(--primary-light);
}
.patch_bay_header {
  display: flex;
  flex-direction: row;
  min-height: 40px;
  width: 100%;
  padding: 0 8px;
  align-items: center;
  border-bottom: 1px solid var(--primary-dark);
}
.patch_bay_fixture_list {
  display: flex;
  width: 200px;
  height: calc(100% - 39px);
}
</style>
