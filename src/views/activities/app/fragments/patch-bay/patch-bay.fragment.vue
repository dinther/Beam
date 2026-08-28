<template>
  <div class="patch_bay">
    <div
      ref="header"
      class="patch_bay_header"
    >
      <h3>Patch Bay</h3>
      <span style="flex: 1" />
      <!-- Hidden rather than removed. A group is on its way to being a saved
           selection set for control, not a thing that moves in the scene --
           structures do that now -- so making one from here offers a concept
           the app is in the middle of retiring. `createGroup` stays: the
           groups in existing shows still load, and this comes back the day
           groups mean something again. -->
      <uk-button
        icon="structure"
        style="margin-right: 8px"
        label="structure"
        :icon-only="compactButtons"
        title="structure"
        @click="createStructure"
      />
      <uk-button
        icon="move"
        style="margin-right: 8px"
        label="arrange"
        :icon-only="compactButtons"
        title="arrange"
        :disabled="!canArrange"
        @click="toggleArrange"
      />
      <uk-button
        icon="new"
        style="margin-right: 8px"
        label="add"
        :icon-only="compactButtons"
        title="add"
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
import { SCENE_ITEM_KINDS, rowId, kindOf } from '@/models/DMX/scene_item';
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
      /**
       * Whether the header buttons are down to their icons.
       *
       * The patch bay sits in a column the user can drag narrower than the
       * four labels need, and a squashed row of half-words is worse than four
       * icons with tooltips.
       */
      compactButtons: false,
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
          id: rowId(SCENE_ITEM_KINDS.GROUP, group.id),
          kind: group.kind,
          uid: group.uid,
          groupId: group.id,
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
      // Objects are scene items too, and flat rows for the same reason
      // structures are. They hold no fixtures and no channels, so nothing here
      // is spoken for by one.
      const objects = (this.show.objects || []).map((object) => object.listable);
      const loose = this.pool.fixtures
        .filter((fixture) => !spokenFor.has(fixture.id))
        .map((fixture) => this.describeFixture(fixture));
      return [...structures, ...objects, ...groups, ...loose];
    },
  },
  mounted() {
    EventBus.on('fixture_picked', this.handleFixturePicked);
    EventBus.on('delete_requested', this.requestDeletion);
    this.watchHeaderWidth();
  },
  beforeUnmount() {
    EventBus.off('fixture_picked', this.handleFixturePicked);
    EventBus.off('delete_requested', this.requestDeletion);
    if (this.headerObserver) this.headerObserver.disconnect();
  },
  methods: {
    /**
     * Drops the header buttons to icons when their labels no longer fit.
     *
     * The full width is measured once, on the first paint, while the labels
     * are still showing -- measuring afterwards would read the compact width
     * and the row would never expand again. Comparing against that fixed
     * number is also what stops the two states flapping into each other, since
     * switching to icons does not change what is being compared.
     *
     * @public
     */
    watchHeaderWidth() {
      const { header } = this.$refs;
      if (!header || typeof ResizeObserver === 'undefined') return;
      this.$nextTick(() => {
        // scrollWidth, not clientWidth: the row overflows rather than shrinks,
        // so this is what the labels actually ask for.
        this.headerFullWidth = header.scrollWidth;
        this.headerObserver = new ResizeObserver(() => {
          this.compactButtons = header.clientWidth < this.headerFullWidth;
        });
        this.headerObserver.observe(header);
      });
    },
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
        id: rowId(SCENE_ITEM_KINDS.FIXTURE, fixture.id),
        kind: fixture.kind,
        uid: fixture.uid,
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
    /**
     * Selects an object from the item list.
     *
     * Objects had no branch of their own here, so a row fell through to the
     * fixture path and was looked up with `findFromId`, which compares against
     * `Number(id)` -- and an object's list id is `object:3`, so that is `NaN`
     * and never matches. The lookup returned null and the handler bailed
     * *before* `clearAllHighlighting`, so clicking an object selected nothing
     * and left whatever was selected before still lit. Two symptoms, one
     * missing branch.
     *
     * @public
     * @param {Number} objectId
     */
    selectObject(objectId) {
      const object = this.$show.objects.find((o) => o.id === objectId);
      if (!object) return;
      this.$router.push({ path: '/patch', query: { objectId } }).catch(() => {});
      Controls.detachAll();
      Controls.clearAllHighlighting();
      // Does the attaching itself, the way a structure's does.
      object.highlightSingle(true, true);
      // An object has no route the modifier watches, so it is announced --
      // the same courtesy the structure path extends.
      Controls.emitSelection(object);
    },
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
      if (kindOf(item) === SCENE_ITEM_KINDS.STRUCTURE) {
        return this.$show.structures.find((s) => s.id === item.structureId) || null;
      }
      if (kindOf(item) === SCENE_ITEM_KINDS.GROUP) {
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
      const groupItems = items.filter((item) => kindOf(item) === SCENE_ITEM_KINDS.GROUP);
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
      const itemKind = kindOf(item);
      if (!item || itemKind === SCENE_ITEM_KINDS.GROUP
        || itemKind === SCENE_ITEM_KINDS.STRUCTURE) return;
      if (kindOf(target) === SCENE_ITEM_KINDS.STRUCTURE) return;
      const fixture = this.pool.findFromId(item.id);
      if (!fixture) return;
      const group = kindOf(target) === SCENE_ITEM_KINDS.GROUP
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
      if (kindOf(fixtureData) === SCENE_ITEM_KINDS.GROUP) {
        this.selectGroup(fixtureData.groupId);
        return;
      }
      if (kindOf(fixtureData) === SCENE_ITEM_KINDS.STRUCTURE) {
        this.selectStructure(fixtureData.structureId);
        return;
      }
      if (kindOf(fixtureData) === SCENE_ITEM_KINDS.OBJECT) {
        this.selectObject(fixtureData.objectId);
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
      fixtures.filter((item) => kindOf(item) === SCENE_ITEM_KINDS.STRUCTURE).forEach((item) => {
        const structure = this.$show.structures.find((s) => s.id === item.structureId);
        if (structure) this.$show.deleteStructure(structure);
      });
      fixtures.filter((item) => kindOf(item) === SCENE_ITEM_KINDS.OBJECT).forEach((item) => {
        const object = this.$show.objects.find((o) => o.id === item.objectId);
        if (object) this.$show.removeObject(object);
      });
      fixtures
        .filter((item) => kindOf(item) === SCENE_ITEM_KINDS.FIXTURE)
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
      // Row ids are namespaced by kind, because the three are separate
      // numbering spaces -- `listable` builds them the same way. An object
      // mapped to a bare number matched no row at all, so an object picked in
      // the 3D view never lit up in the list.
      this.highlightedIds = (payload.selectedItems || []).map((item) => {
        if (item.kind === 'structure') return `structure:${item.id}`;
        if (item.kind === 'object') return `object:${item.id}`;
        return item.id;
      });
      if (payload.fixtureId === undefined) return;
      this.$router.push({ path: '/patch', query: { fixtureId: payload.fixtureId } }).catch(() => {});
    },
    /**
     * Deletes what the 3D view has selected, there and then.
     *
     * Resolved to list rows first so this goes through the one deletion path
     * the list already uses -- a structure taking its members with it, a
     * fixture releasing its addresses -- rather than a second one that would
     * drift from it.
     *
     * @public
     * @param {Array} selection `{kind, id}` entries from the 3D view
     */
    requestDeletion(selection) {
      // One comparison for every kind, now that a row carries its own. This
      // was three branches that each had to know about the others, and the
      // fixture case was "none of the above" -- so a kind nobody had added yet
      // quietly matched fixtures.
      const rows = this.listable.filter((row) => (selection || [])
        .some((entry) => kindOf(row) === entry.kind && row.uid === entry.uid));
      if (rows.length) this.deleteFixtures(rows);
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
     * Everything added is selected, not just the first of a batch: adding
     * four fixtures and finding one of them selected means arranging them is a
     * re-selection away, when the set is already exactly what was wanted.
     *
     * A single item routes the list as a plain click would, so its widgets come
     * up. Several go through `Controls.selectItem`, which is the same path
     * ctrl-clicking them one by one would take.
     *
     * @public
     * @param {Object} placed `{ kind, ids }` of everything just added
     */
    selectPlaced(placed) {
      if (!placed) return;
      // `id` is still accepted so an emitter that has not been updated, or one
      // added later, does not silently select nothing.
      const ids = (placed.ids && placed.ids.length)
        ? placed.ids
        : [placed.id].filter((id) => id !== undefined);
      const handles = ids
        .map((id) => this.placedHandle(placed.kind, id))
        .filter(Boolean);
      if (!handles.length) return;

      if (handles.length === 1) {
        if (placed.kind === 'structure') {
          this.selectStructure(handles[0].id);
        } else if (placed.kind === 'object') {
          this.selectObject(handles[0].id);
        } else {
          this.displayFixture(this.describeFixture(handles[0]));
        }
        return;
      }

      Controls.clearAllHighlighting();
      // Additive from the second on, exactly as holding ctrl would be.
      handles.forEach((handle, index) => Controls.selectItem(handle, index > 0));
    },
    /**
     * The model an added item's id refers to, by kind.
     *
     * Kinds are separate numbering spaces -- object 3 and fixture 3 are
     * different things -- so the kind decides where to look.
     *
     * @public
     * @param {String} kind 'fixture', 'structure' or 'object'
     * @param {Number} id
     * @returns {Object|null}
     */
    placedHandle(kind, id) {
      if (kind === 'structure') return this.$show.structures.find((s) => s.id === id) || null;
      if (kind === 'object') return this.$show.objects.find((o) => o.id === id) || null;
      return this.pool.findFromId(id);
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
  /* Fixed, not a minimum. An icon-only button is taller than a labelled one,
     so a row free to grow changed height the moment the labels dropped out. */
  height: 30px;
  min-height: 30px;
  width: 100%;
  padding: 0 8px;
  align-items: center;
  border-bottom: 1px solid var(--primary-dark);
}
.patch_bay_header :deep(.uikit_button.icon_only) {
  /* Sized to sit inside the row with a little air above and below, rather
     than filling it edge to edge as the default 30px square would. */
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
}
.patch_bay_header :deep(.uikit_button) {
  /* Held at their natural width so the row genuinely overflows when the
     labels do not fit. Allowed to shrink they would squash into each other
     instead, and there would be nothing to measure. */
  flex-shrink: 0;
}
.patch_bay_header h3 {
  /* The title yields first: it is the one thing here that is only a label. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.patch_bay_fixture_list {
  display: flex;
  width: 100%;
  /* The header and the hairline under it. */
  height: calc(100% - 31px);
}
</style>
