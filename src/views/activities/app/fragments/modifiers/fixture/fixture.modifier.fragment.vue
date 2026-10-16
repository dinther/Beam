<template>
  <uk-flex class="fixture_modifier">
    <!-- Shown while measuring, and for a selected measurement. -->
    <measure-widget v-if="showsMeasure" />
    <structure-widget
      v-if="selectedStructure"
      :structure="selectedStructure"
      :highlighted-ids="memberIds"
      @highlight-members="setMemberIds"
      @exploded="clearStructure"
    />
    <object-widget
      v-if="selectedObject"
      :object="selectedObject"
    />
    <!-- For one object or several: the parts their models let be recoloured. -->
    <object-colours-widget
      v-if="colourObjects.length"
      :objects="colourObjects"
    />
    <!-- High level to detail: what the fixture *is* (its definition), then
         what this one is set to, then where it stands. -->
    <!-- Several fixtures of one definition share these: the Model widget
         speaks for the definition anyway, and the settings write to all. -->
    <model-widget
      v-show="shownFixture"
      ref="model"
      :fixture="shownFixture"
    />
    <fixture-settings-widget
      v-show="shownFixture"
      ref="settings"
      :fixture="shownFixture"
      :fixtures="sharedFixtures"
    />
    <!-- One placement widget for whatever single thing is selected, of
         whatever kind, under one name and one guard. -->
    <placement-widget
      v-if="selectedItem"
      :fixture="selectedItem"
    />
    <!-- One highlighted structure member gets its own, beside the structure's:
         the member is reachable but not movable, and the two side by side need
         different titles to say which is which. Several get none; moving them
         together is what moving the structure is for. -->
    <placement-widget
      v-if="selectedMember"
      :fixture="selectedMember"
      title="Member placement"
    />
    <group-widget
      v-show="selectedGroup"
      :group="selectedGroup"
    />
    <placement-widget
      v-if="showsManyItems"
      :fixture="selectionTransform"
      :title="`Placement · ${selectionTransform.count} items`"
    />
    <arrange-widget
      v-if="showsManyItems && arrangeOpen"
      :items="selectedItems"
    />
    <h3
      v-if="!selectedItem && !showsManyItems && !selectedGroup && !showsMeasure"
      class="empty_text"
    >
      Nothing Selected
    </h3>
  </uk-flex>
</template>

<script>
import { toRaw } from 'vue';
import EventBus from '@/plugins/eventbus';
import Selection from '@/models/DMX/selection';
import SelectionTransform from '@/models/DMX/selection_transform';
import MeasureTool from '@/plugins/visualizer/measure_tool';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';

import FixtureSettingsWidget from './_widgets/fixture.modifier.widget.settings.vue';
import PlacementWidget from '../placement/placement.widget.vue';
import ModelWidget from './_widgets/fixture.modifier.widget.model.vue';
import ArrangeWidget from './_widgets/fixture.modifier.widget.arrange.vue';
import GroupWidget from '../group/group.modifier.widget.vue';
import StructureWidget from '../structure/structure.modifier.widget.vue';
import ObjectWidget from '../object/object.modifier.widget.vue';
import ObjectColoursWidget from '../object/object.colours.widget.vue';
import MeasureWidget from '../measure/measure.widget.vue';

export default {
  name: 'FixtureModifierFragment',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  components: {
    ModelWidget,
    FixtureSettingsWidget,
    PlacementWidget,
    ArrangeWidget,
    GroupWidget,
    StructureWidget,
    ObjectWidget,
    ObjectColoursWidget,
    MeasureWidget,
  },
  data() {
    return {
      /**
       * Currently selected group, when a group rather than a fixture is what
       * the patch bay routed to.
       */
      selectedGroup: null,
      /**
       * Whether the Arrange panel has been asked for. Driven by the patch
       * bay's button rather than by the selection itself.
       */
      arrangeOpen: false,
      /**
       * Row ids of the selected structure's members highlighted in its list:
       * what the fixture widgets edit. Every member when the structure is
       * first selected.
       */
      memberIds: [],
      /**
       * A member picked in the 3D view with Alt, waiting for its structure to
       * become the selected one: `{ structure, rowId }`.
       */
      memberPick: null,
      /** The measure tool's state, for whether its widget shows. */
      measure: MeasureTool.state,
    };
  },
  computed: {
    /**
     * The one selected item, whatever kind it is -- null when nothing is
     * selected, and null when several things are.
     *
     * **One guard, every kind.** A guard per kind would each carry its own
     * idea of when to show -- and one that forgets to check the count puts a
     * single-item editor on screen beside the multi-item one for a selection
     * of two. The kinds still get their own *editors* below, because an object
     * and a structure genuinely are different things to edit -- but whether
     * one thing is selected is asked once.
     *
     * From the store, not the route: the route names one thing at most, and
     * router navigation is asynchronous, so `?fixtureId=` for the first of a
     * batch would land after the rest and overwrite it.
     *
     * @returns {Object|null}
     */
    selectedItem() {
      if (this.selectedGroup) return null;
      return this.selectedItems.length === 1 ? this.selectedItems[0] : null;
    },
    /**
     * The fixture the single-fixture widgets edit, or null.
     *
     * @returns {Object|null}
     */
    selectedFixture() {
      return this.oneOfKind(SCENE_ITEM_KINDS.FIXTURE);
    },
    /**
     * The fixture whose settings and patching are on screen: a member being
     * looked at inside a structure, or the selected fixture itself.
     *
     * @returns {Object|null}
     */
    /**
     * The selected fixtures, when there are several and all of them are one
     * definition -- the case where their settings can be edited together.
     * Empty otherwise.
     *
     * @returns {Array}
     */
    sharedFixtures() {
      // Highlighted structure members follow the same rule as selected
      // fixtures.
      const items = this.selectedStructure ? this.highlightedMembers : this.selectedItems;
      if (items.length < 2) return [];
      if (!items.every((item) => kindOf(item) === SCENE_ITEM_KINDS.FIXTURE)) return [];
      const key = items[0].profileKey;
      return items.every((item) => item.profileKey === key) ? items : [];
    },
    /**
     * The fixture the Model and settings widgets are drawn for: the one being
     * edited, or the first of several that share a definition.
     *
     * @returns {Object|null}
     */
    shownFixture() {
      return this.editedFixture || this.sharedFixtures[0] || null;
    },
    editedFixture() {
      const member = this.selectedMember;
      if (member && kindOf(member) === SCENE_ITEM_KINDS.FIXTURE) return member;
      return member ? null : this.selectedFixture;
    },
    /**
     * The selected structure's members highlighted in its list, in member
     * order. The structure is what is *selected*; which of its members the
     * panel edits is this panel's own state.
     *
     * @returns {Array}
     */
    highlightedMembers() {
      if (!this.selectedStructure) return [];
      // By row id: row ids are namespaced by kind, so this finds an object
      // member as readily as a fixture.
      return this.selectedStructure.members
        .filter((member) => this.memberIds.includes(member.listable.id));
    },
    /**
     * The one highlighted structure member, or null for none or several.
     *
     * @returns {Object|null}
     */
    selectedMember() {
      return this.highlightedMembers.length === 1 ? this.highlightedMembers[0] : null;
    },
    /**
     * Everything in the selection, of whatever kind.
     *
     * Resolved by kind against the pool that owns it -- ids are not unique
     * between kinds, so one lookup for all of them hands back the wrong thing.
     *
     * @returns {Array}
     */
    selectedItems() {
      return Selection.items.map((entry) => {
        if (entry.kind === SCENE_ITEM_KINDS.STRUCTURE) {
          return this.$show.structures.find((item) => item.uid === entry.uid);
        }
        if (entry.kind === SCENE_ITEM_KINDS.OBJECT) {
          return this.$show.objects.find((item) => item.uid === entry.uid);
        }
        return this.$show.fixturePool.findFromId(entry.id);
      }).filter(Boolean);
    },
    /**
     * The selected structure, or null -- read from the selection store.
     *
     * Derived, not kept: a field would need every code path to remember to
     * clear it. A view cannot be stale.
     *
     * @returns {Object|null}
     */
    /**
     * The selection as one transform, for the position tool.
     *
     * Rebuilt whenever the selection changes, and reads straight through to
     * the items -- so it holds nothing that could fall out of step with them.
     *
     * @type {Object}
     */
    selectionTransform() {
      return new SelectionTransform(this.selectedItems);
    },
    selectedStructure() {
      return this.oneOfKind(SCENE_ITEM_KINDS.STRUCTURE);
    },
    /**
     * The selected object, or null -- read from the selection store.
     *
     * @returns {Object|null}
     */
    selectedObject() {
      return this.oneOfKind(SCENE_ITEM_KINDS.OBJECT);
    },
    /**
     * The selected objects that take colours: every library model, by tint and
     * by part. A created shape has its own colour parameter instead. Asked of
     * the library entry, not the loaded model, so the widget stays open while
     * Vary pose swaps a model.
     *
     * @returns {Array}
     */
    colourObjects() {
      return this.selectedItems.filter((item) => {
        if (kindOf(item) !== SCENE_ITEM_KINDS.OBJECT) return false;
        const entry = this.$show.objectLibraryEntry(item);
        return !!(entry && !entry.primitive);
      });
    },
    /**
     * Whether a selection of two or more items is live.
     *
     * Items, not fixtures: three structures are three things to arrange, and
     * counting the fixtures inside them would put every one of them on a
     * single line.
     *
     * No per-kind exclusions. `selectedItem` answers null for anything but a
     * single item, so the two cannot disagree.
     *
     * @property {Boolean} showsManyItems
     */
    showsManyItems() {
      return !this.selectedGroup && this.selectedItems.length > 1;
    },
    /**
     * Whether the Measure widget shows: while measuring, and while a
     * measurement is selected.
     *
     * @returns {Boolean}
     */
    showsMeasure() {
      return this.measure.active || this.measure.selectedId !== null;
    },
  },
  watch: {
    /**
     * A member belongs to the structure it is in, so it is let go when that
     * stops being the selected one -- otherwise picking a second structure
     * opens it with the first one's member still showing, and `memberId`
     * resolves against the pool to a fixture this structure does not hold.
     */
    selectedStructure(structure, previous) {
      if (toRaw(structure) === toRaw(previous)) return;
      if (previous && previous._3DModel) previous._3DModel.setLitMembers(null);
      const pick = this.memberPick;
      this.memberPick = null;
      if (structure && pick && toRaw(pick.structure) === toRaw(structure)) {
        this.memberIds = [pick.rowId];
      } else {
        this.memberIds = structure ? structure.members.map((member) => member.listable.id) : [];
      }
    },
    /** Only the highlighted members are outlined in the 3D view. */
    highlightedMembers(members) {
      const structure = this.selectedStructure;
      if (structure && structure._3DModel) structure._3DModel.setLitMembers(members);
    },
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
    EventBus.on('arrange_toggled', this.setArrangeOpen);
    EventBus.on('structure_member_picked', this.handleMemberPicked);
  },
  beforeUnmount() {
    if (this.selectedStructure && this.selectedStructure._3DModel) {
      this.selectedStructure._3DModel.setLitMembers(null);
    }
    EventBus.off('fixture_picked', this.handleFixturePicked);
    EventBus.off('arrange_toggled', this.setArrangeOpen);
    EventBus.off('structure_member_picked', this.handleMemberPicked);
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
    /**
     * Kept so the route can still name a fixture, but it does not *select*.
     *
     * Selection comes from the store. The route is pushed as a consequence of
     * selecting, so having it write back would be a second source of truth --
     * and an asynchronous one, overwriting a multi-selection with a single
     * item after the fact.
     *
     * @public
     * @param {Number} id
     */
    // eslint-disable-next-line no-unused-vars, class-methods-use-this
    selectFixture(id) {},
    /**
     * The single selected item, when it happens to be of this kind.
     *
     * A method rather than three computeds' worth of duplicated guard: the
     * "is one thing selected" question is asked once, in `selectedItem`, and
     * this only narrows the answer by kind.
     *
     * @public
     * @param {String} kind one of `SCENE_ITEM_KINDS`
     * @returns {Object|null}
     */
    oneOfKind(kind) {
      const item = this.selectedItem;
      return item && kindOf(item) === kind ? item : null;
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
     * Follows the Arrange button.
     *
     * @public
     * @param {Boolean} open whether the panel should be showing
     */
    setArrangeOpen(open) {
      this.arrangeOpen = !!open;
    },
    /**
     * Sets which structure members the widgets edit, from the member list.
     *
     * @public
     * @param {Array} ids member row ids
     */
    setMemberIds(ids) {
      this.memberIds = Array.isArray(ids) ? ids : [];
    },
    /**
     * A member Alt-clicked in the 3D view: its structure is selected, and the
     * member is highlighted alone. The structure may be selected already, in
     * which case `selectedStructure` does not change and the pick is applied
     * here; otherwise the watcher applies it.
     *
     * @public
     * @param {Object} payload `{ structure, member }`
     */
    handleMemberPicked({ structure, member }) {
      if (!structure || !member || !member.listable) return;
      const rowId = member.listable.id;
      this.memberPick = { structure, rowId };
      if (toRaw(this.selectedStructure) === toRaw(structure)) this.memberIds = [rowId];
    },
    /**
     * Drops the structure entirely, once it has stopped being one item.
     *
     * Only the member highlight is let go here. Which structure is selected belongs to
     * the selection store; the panel empties because exploding a structure
     * changes the selection.
     *
     * @public
     */
    clearStructure() {
      this.memberIds = [];
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
     * @param {Object} payload {fixtureId, structureId, selectedItems,
     *   selectedIds}, or null when cleared
     */
    handleFixturePicked(payload) {
      // Nothing to copy. The primary, the fixtures and the whole typed
      // selection are computed views of the selection store, and a view cannot
      // be stale or be overwritten by whichever channel happened to fire last.
      if (!payload) this.selectedGroup = null;
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
