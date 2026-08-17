<template>
  <div class="patch_bay">
    <div class="patch_bay_header">
      <h3>Patch Bay</h3>
      <span style="flex: 1" />
      <uk-button
        icon="grid"
        style="margin-right: 8px"
        label="group"
        @click="createGroup"
      />
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
      draggable
      auto-select-first
      class="patch_bay_fixture_list"
      filterable
      :items="listable"
      :highlight-ids="highlightedFixtureIds"
      @select="displayFixture"
      @highlight="highlightFixtures"
      @delete="deleteFixtures"
      @reparent="reparentItem"
    />
    <patch-popup v-model="patchPopupDisplayState" />
  </div>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import Controls from '@/plugins/visualizer/controls';
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
      show: this.$show,
      patchPopupDisplayState: false,
      /**
       * Ids of fixtures selected in the 3D view, mirrored into the list.
       */
      highlightedFixtureIds: [],
    };
  },
  computed: {
    /**
     * The patch bay as a tree: groups first, holding their members, then
     * everything still at the root.
     *
     * Built here rather than on the pool because grouping is a scene concern,
     * not something the pool knows about.
     *
     * @type {Array}
     */
    listable() {
      const grouped = new Set();
      const groups = this.show.groups.map((group) => {
        group.members.forEach((member) => grouped.add(member.id));
        // Its own icon rather than the selector's folder: a group is a thing
        // in the show, not a place to look in.
        return {
          name: group.name,
          icon: 'group',
          id: `group:${group.id}`,
          groupId: group.id,
          isGroup: true,
          unfold: group.members.map((member) => this.describeFixture(member)),
        };
      });
      const loose = this.pool.fixtures
        .filter((fixture) => !grouped.has(fixture.id))
        .map((fixture) => this.describeFixture(fixture));
      return [...groups, ...loose];
    },
  },
  mounted() {
    EventBus.on('fixture_picked', this.handleFixturePicked);
  },
  beforeUnmount() {
    EventBus.off('fixture_picked', this.handleFixturePicked);
  },
  methods: {
    /**
     * One fixture as a list entry.
     *
     * @public
     * @param {Object} fixture fixture instance
     * @returns {Object} list item
     */
    describeFixture(fixture) {
      return {
        name: fixture.name,
        icon: 'movinghead',
        id: fixture.id,
        universe: fixture.universe,
        address: fixture.address,
        more: `U${fixture.universe} - CH${fixture.chStart + 1}`,
      };
    },
    /**
     * Selects a group in the 3D view, so the gizmo moves the whole thing.
     *
     * @public
     * @param {Number} groupId id of the group to select
     */
    selectGroup(groupId) {
      const group = this.$show.groups.find((candidate) => candidate.id === groupId);
      if (!group) return;
      // Routed like a fixture is, so the modifier follows the selection
      // whichever kind of thing it turns out to be.
      this.$router.push({ path: '/patch', query: { groupId } }).catch(() => {});
      Controls.detachAll();
      Controls.clearAllHighlighting();
      group.highlightSingle(true);
      Controls.attach(group);
    },
    /**
     * Deletes any groups in a deletion, along with the fixtures they hold.
     *
     * @public
     * @param {Array} items list entries being deleted
     * @returns {Boolean} whether a group was handled
     */
    deleteGroups(items) {
      const groupItems = items.filter((item) => item && item.isGroup);
      if (!groupItems.length) return false;
      groupItems.forEach((item) => {
        const group = this.$show.groups.find((candidate) => candidate.id === item.groupId);
        if (group) this.$show.deleteGroup(group);
      });
      return true;
    },
    /**
     * Creates a group from whatever is selected, or an empty one when nothing
     * is.
     *
     * @public
     */
    createGroup() {
      const members = this.highlightedFixtureIds
        .map((id) => this.pool.findFromId(id))
        .filter(Boolean);
      this.$show.createGroup(members);
    },
    /**
     * Moves a dragged item into a group, or out to the root.
     *
     * @public
     * @param {Object} payload {item, target} from the list
     */
    reparentItem({ item, target }) {
      if (!item || item.isGroup) return;
      const fixture = this.pool.findFromId(item.id);
      if (!fixture) return;
      const group = target && target.isGroup
        ? this.$show.groups.find((g) => g.id === target.groupId)
        : null;
      this.$show.moveToGroup(fixture, group);
    },
    /**
     * Routes to the selected fixture, which the modifier follows.
     *
     * @public
     * @param {Object} fixtureData listable entry of the selected fixture
     */
    displayFixture(fixtureData) {
      if (!fixtureData) return;
      if (fixtureData.isGroup) {
        this.selectGroup(fixtureData.groupId);
        return;
      }
      this.$router.push({ path: '/patch', query: { fixtureId: fixtureData.id } }).catch(() => {});
      // The route drives the modifier widgets; the 3D view has to be told
      // separately. uk-list emits 'highlight' only for multi-selection, so a
      // plain click would otherwise select a fixture everywhere but the scene.
      const fixture = this.pool.findFromId(fixtureData.id);
      if (!fixture) return;
      // Clear first: the previous selection may have been a group, which
      // highlightSingle knows nothing about.
      Controls.clearAllHighlighting();
      fixture.highlightSingle(true, true);
    },
    /**
     * Mirrors a list multi-selection into the 3D view.
     *
     * @public
     * @param {Array} fixtures listable entries of the highlighted fixtures
     */
    highlightFixtures(fixtures) {
      if (!fixtures.length) return;
      Controls.clearAllHighlighting();
      fixtures.forEach((fixtureData, index) => {
        const fixture = this.pool.findFromId(fixtureData.id);
        if (!fixture) return;
        if (index === 0) {
          fixture.highlightSingle(false, false);
        }
        fixture.highlight(true, true);
      });
      // Highlighting attaches each fixture to the gizmo, but nothing has said
      // so out loud -- and anything watching the selection rather than the
      // list would never hear about a selection made here. Same rule the 3D
      // view uses: a primary is only named when there is exactly one, since
      // naming one of many routes the list back to it and collapses the
      // selection that was just made.
      Controls.emitSelection(
        Controls.pooledInstances.length === 1 ? Controls.pooledInstances[0] : null,
      );
    },
    /**
     * Deletes the highlighted fixtures from the show.
     *
     * @public
     * @param {Array} fixtures listable entries of the fixtures to delete
     */
    deleteFixtures(fixtures) {
      // Deleting a group takes its fixtures with it; the group widget's
      // ungroup is what leaves them behind.
      if (this.deleteGroups(fixtures)) return;
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
  /* Fills the column width the splitter sets, rather than the list's content width. */
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--primary-light);
}
.patch_bay_header {
  display: flex;
  flex-direction: row;
  min-height: 28px;
  width: 100%;
  padding: 0 8px;
  align-items: center;
  border-bottom: 1px solid var(--primary-dark);
}
.patch_bay_fixture_list {
  display: flex;
  width: 100%;
  height: calc(100% - 29px);
}
</style>
