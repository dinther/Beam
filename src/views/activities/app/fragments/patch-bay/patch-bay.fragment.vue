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
        icon="structure"
        style="margin-right: 8px"
        label="structure"
        @click="createStructure"
      />
      <uk-button
        icon="move"
        style="margin-right: 8px"
        label="arrange"
        :disabled="!canArrange"
        @click="toggleArrange"
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
      class="patch_bay_fixture_list"
      filterable
      :items="listable"
      :highlight-ids="highlightedIds"
      @select="displayFixture"
      @highlight="highlightFixtures"
      @delete="deleteFixtures"
      @reparent="reparentItem"
    />
    <patch-popup
      v-model="patchPopupDisplayState"
      @placed="selectPlaced"
    />
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
       * Ids of items selected in the 3D view, mirrored into the list. Mixed:
       * a fixture is its numeric id, a structure the `structure:N` its row
       * carries, since the two number themselves independently.
       */
      highlightedIds: [],
      /**
       * Whether the Arrange panel is open.
       *
       * Opening it is a decision, not a consequence of selecting things: the
       * panel previews a layout the moment it appears, and a multi-selection
       * is made for plenty of reasons that are not "lay these out again".
       */
      arrangeOpen: false,
    };
  },
  computed: {
    /**
     * Whether there is anything to arrange. One item has no arrangement.
     *
     * @property {Boolean} canArrange
     */
    canArrange() {
      return this.highlightedIds.length > 1;
    },
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
      const spokenFor = new Set();
      const groups = this.show.groups.map((group) => {
        group.members.forEach((member) => spokenFor.add(member.id));
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
      // Structures are flat rows with nothing to unfold. What they hold sits
      // at coordinates relative to them, which makes those things not scene
      // items -- they are reached through the structure's own widget, and
      // putting them here would contradict what this list is.
      const structures = this.show.structures.map((structure) => {
        structure.members.forEach((member) => spokenFor.add(member.id));
        return structure.listable;
      });
      const loose = this.pool.fixtures
        .filter((fixture) => !spokenFor.has(fixture.id))
        .map((fixture) => this.describeFixture(fixture));
      return [...structures, ...groups, ...loose];
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
        icon: fixture.isBar ? 'ledbar' : 'movinghead',
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
     * Selects a structure in the 3D view, so the gizmo moves the whole thing.
     *
     * @public
     * @param {Number} structureId id of the structure to select
     */
    selectStructure(structureId) {
      const structure = this.$show.structures.find((s) => s.id === structureId);
      if (!structure) return;
      this.$router.push({ path: '/patch', query: { structureId } }).catch(() => {});
      Controls.detachAll();
      Controls.clearAllHighlighting();
      structure.highlightSingle(true);
      Controls.attach(structure);
      // The route drives the group and fixture widgets, but a structure has no
      // route of its own that the modifier watches, so it is announced.
      Controls.emitSelection(structure);
    },
    /**
     * Resolves a list row back to the thing it stands for.
     *
     * @public
     * @param {Object} item list row
     * @returns {Object|null} the structure, group or fixture it names
     */
    itemFromRow(item) {
      if (!item) return null;
      if (item.isStructure) {
        return this.$show.structures.find((s) => s.id === item.structureId) || null;
      }
      if (item.isGroup) {
        return this.$show.groups.find((g) => g.id === item.groupId) || null;
      }
      return this.pool.findFromId(item.id);
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
      const members = this.highlightedIds
        .map((id) => this.pool.findFromId(id))
        .filter(Boolean);
      this.$show.createGroup(members);
    },
    /**
     * Makes one structure out of the selected fixtures.
     *
     * Structures take fixtures and objects, not other structures, so a
     * selection that already holds one contributes only its loose items.
     *
     * @public
     */
    createStructure() {
      const members = this.highlightedIds
        .map((id) => this.pool.findFromId(id))
        .filter(Boolean)
        .filter((fixture) => !fixture.structure);
      if (!members.length) return;
      const structure = this.$show.createStructure(members);
      this.selectStructure(structure.id);
    },
    /**
     * Moves a dragged item into a group, or out to the root.
     *
     * @public
     * @param {Object} payload {item, target} from the list
     */
    reparentItem({ item, target }) {
      // A structure is one item, and what it holds is not in this list, so
      // there is nothing to drag into or out of one.
      if (!item || item.isGroup || item.isStructure) return;
      if (target && target.isStructure) return;
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
      if (fixtureData.isStructure) {
        this.selectStructure(fixtureData.structureId);
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
      // Rows are resolved by kind rather than run through the fixture pool: a
      // structure row's id is a string, and asking the pool for it used to
      // return nothing, so structures dropped silently out of a mixed
      // selection.
      fixtures.forEach((fixtureData, index) => {
        const item = this.itemFromRow(fixtureData);
        if (!item) return;
        if (index === 0) {
          item.highlightSingle(false, false);
        }
        item.highlight(true, true);
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
      // Every kind in the selection is handled, rather than returning after
      // the first one found: a selection holding a structure and a loose
      // fixture used to delete the one and silently spare the other.
      //
      // Deleting a structure or a group takes its contents with it; explode
      // and ungroup are what leave them behind.
      this.deleteGroups(fixtures);
      fixtures.filter((item) => item && item.isStructure).forEach((item) => {
        const structure = this.$show.structures.find((s) => s.id === item.structureId);
        if (structure) this.$show.deleteStructure(structure);
      });
      fixtures
        .filter((item) => item && !item.isGroup && !item.isStructure)
        .forEach((fixtureData) => this.$show.deleteFixture(fixtureData));
    },
    /**
     * Reflects a selection made in the 3D view.
     *
     * @public
     * @param {Object} payload {fixtureId, selectedIds}, or null to clear
     */
    handleFixturePicked(payload) {
      if (!payload) {
        this.highlightedIds = [];
        return;
      }
      // A new selection closes the panel. Left open it would re-arrange the
      // next two things picked, which is the surprise this button exists to
      // remove.
      this.setArrangeOpen(false);
      // Built from the typed selection, so a structure highlights its own row
      // rather than whichever fixture happens to share its number.
      this.highlightedIds = (payload.selectedItems || []).map((item) => (
        item.kind === 'structure' ? `structure:${item.id}` : item.id
      ));
      if (payload.fixtureId === undefined) return;
      this.$router.push({ path: '/patch', query: { fixtureId: payload.fixtureId } }).catch(() => {});
    },
    /**
     * Opens or closes the Arrange panel for the current selection.
     *
     * @public
     */
    toggleArrange() {
      if (!this.canArrange) return;
      this.setArrangeOpen(!this.arrangeOpen);
    },
    /**
     * Announces the panel's state, so the modifier column can follow it.
     *
     * @public
     * @param {Boolean} open whether the panel should be showing
     */
    setArrangeOpen(open) {
      if (this.arrangeOpen === open) return;
      this.arrangeOpen = open;
      EventBus.emit('arrange_toggled', open);
    },
    /**
     * Selects what "+ New" just added.
     *
     * The list used to select its own first row on mount, which meant
     * something looked selected that the user had never chosen. Selecting the
     * thing they just created is the part that was actually wanted.
     *
     * @public
     * @param {Object} placed {kind, id} of the first item added
     */
    selectPlaced(placed) {
      if (!placed) return;
      if (placed.kind === 'structure') {
        this.selectStructure(placed.id);
        return;
      }
      const fixture = this.pool.findFromId(placed.id);
      if (fixture) this.displayFixture(this.describeFixture(fixture));
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
