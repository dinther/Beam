<template>
  <uk-flex class="fixture_modifier">
    <structure-widget
      v-if="selectedStructure"
      :structure="selectedStructure"
      :selected-member-id="memberId"
      @select-member="selectMember"
      @exploded="clearStructure"
    />
    <object-widget
      v-if="selectedObject"
      :object="selectedObject"
    />
    <!-- One tool for whatever single thing is selected, of whatever kind.
         There were three of these, one per kind, each shown by its own guard;
         the guards were hardened one at a time and the object one never was. -->
    <position-tool-widget
      v-if="selectedItem"
      ref="positionTool"
      :fixture="selectedItem"
      :title="positionTitle"
    />
    <model-widget
      v-show="editedFixture"
      ref="model"
      :fixture="editedFixture"
    />
    <fixture-settings-widget
      v-show="editedFixture"
      ref="settings"
      :fixture="editedFixture"
    />
    <!-- A structure's member gets its own, beside the structure's: the member
         is reachable but not movable, and two tools side by side with
         different titles say which is which. -->
    <position-tool-widget
      v-if="selectedMember"
      :fixture="selectedMember"
    />
    <group-widget
      v-show="selectedGroup"
      :group="selectedGroup"
    />
    <position-tool-widget
      v-if="showsManyItems"
      :fixture="selectionTransform"
      :title="`${selectionTransform.count} items`"
    />
    <arrange-widget
      v-if="showsManyItems && arrangeOpen"
      :items="selectedItems"
    />
    <h3
      v-if="!selectedItem && !showsManyItems && !selectedGroup"
      class="empty_text"
    >
      Nothing Selected
    </h3>
  </uk-flex>
</template>

<script>
import EventBus from '@/plugins/eventbus';
import Selection from '@/models/DMX/selection';
import SelectionTransform from '@/models/DMX/selection_transform';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';

import FixtureSettingsWidget from './_widgets/fixture.modifier.widget.settings.vue';
import PositionToolWidget from './_widgets/fixture.modifier.widget.position.tool.vue';
import ModelWidget from './_widgets/fixture.modifier.widget.model.vue';
import ArrangeWidget from './_widgets/fixture.modifier.widget.arrange.vue';
import GroupWidget from '../group/group.modifier.widget.vue';
import StructureWidget from '../structure/structure.modifier.widget.vue';
import ObjectWidget from '../object/object.modifier.widget.vue';

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
    StructureWidget,
    ObjectWidget,
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
       * Which member of the selected structure the panel has opened, by
       * fixture id, or null for none. See `selectedMember`.
       */
      memberId: null,
    };
  },
  computed: {
    /**
     * The one selected item, whatever kind it is -- null when nothing is
     * selected, and null when several things are.
     *
     * **One guard, every kind.** There used to be three of these, one per
     * kind, each asking `Selection.primary` for its own kind and each carrying
     * its own idea of when to show. They were hardened against
     * multi-selections one at a time: `showsOneFixture` learned to check the
     * count after a nudge in the position tool moved one fixture out of a set
     * that looked selected, and `selectedObject` and `selectedStructure` never
     * learned it at all -- so two selected speakers put a single-object editor
     * on screen beside the multi-item one, and nudging the single one dropped
     * the other speaker out of the selection.
     *
     * That is the `scene_item.js` fault one layer up: kind-dispatch repeated
     * per consumer, where every new kind has to be remembered separately. The
     * kinds still get their own *editors* below, because an object and a
     * structure genuinely are different things to edit -- but whether one
     * thing is selected is asked once.
     *
     * From the store, not the route: the route names one thing at most, and
     * router navigation is asynchronous, so `?fixtureId=` for the first of a
     * batch used to land after the rest and overwrite it.
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
    editedFixture() {
      return this.selectedMember || this.selectedFixture;
    },
    /**
     * The structure member being looked at, or null.
     *
     * Component state rather than a view of the selection store, because that
     * is what it is: the structure is what is *selected*, and which of its
     * members the panel has opened is this panel's own business. It was
     * written straight into `selectedFixture` before, which stopped working
     * silently when that became a computed -- Vue refuses the write, so
     * picking a member did nothing at all.
     *
     * @returns {Object|null}
     */
    selectedMember() {
      if (!this.selectedStructure || this.memberId === null) return null;
      return this.$show.fixturePool.findFromId(this.memberId) || null;
    },
    /**
     * What the single-item position tool calls itself, so two of them side by
     * side -- a structure and one of its members -- say which is which.
     *
     * @returns {String}
     */
    positionTitle() {
      switch (kindOf(this.selectedItem)) {
        case SCENE_ITEM_KINDS.STRUCTURE: return 'Structure Position';
        case SCENE_ITEM_KINDS.OBJECT: return 'Object Position';
        default: return 'Position Tool';
      }
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
     * Derived, not kept. This was a field that several code paths had to
     * remember to clear, and the one that forgot left a structure's widgets on
     * screen over a fixture. A view cannot be stale.
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
     * Whether a selection of two or more items is live.
     *
     * Items, not fixtures: three structures are three things to arrange, and
     * counting the fixtures inside them is what put every one of them on a
     * single line.
     *
     * No per-kind exclusions any more. It used to name groups and structures
     * by hand, which is the same list-of-kinds that let objects fall through
     * -- and it meant two selected structures were three things to arrange by
     * the comment above and one thing by the code. `selectedItem` answers null
     * for anything but a single item, so the two cannot disagree.
     *
     * @property {Boolean} showsManyItems
     */
    showsManyItems() {
      return !this.selectedGroup && this.selectedItems.length > 1;
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
      if (structure === previous) return;
      this.highlightMember(false);
      this.memberId = null;
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
  },
  beforeUnmount() {
    this.highlightMember(false);
    EventBus.off('fixture_picked', this.handleFixturePicked);
    EventBus.off('arrange_toggled', this.setArrangeOpen);
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
     * Kept so the route can still name a fixture, but it no longer *selects*.
     *
     * Selection comes from the store. The route is pushed as a consequence of
     * selecting, so having it write back was a second source of truth -- and an
     * asynchronous one, which is how it came to overwrite a multi-selection
     * with a single item after the fact.
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
     * Opens a structure member's own widgets, keeping the structure up.
     *
     * A member is reachable but not movable: its settings and patching are the
     * point of picking it, and the position tool locks itself on the way in.
     *
     * @public
     * @param {Number|null} id member fixture id, or null when there is none
     */
    selectMember(id) {
      this.highlightMember(false);
      // Null is "no member", not "no structure": clicking the picked member
      // again drops it and leaves the structure showing, which is how you get
      // back to placing the structure itself.
      this.memberId = (id === null || id === undefined) ? null : id;
      this.highlightMember(true);
    },
    /**
     * Shows, or stops showing, which member is being looked at.
     *
     * `highlight(state, false)` and never true: the second argument is what
     * attaches the gizmo, and a structure's member is not the user's to drag.
     * The structure keeps the gizmo the whole time.
     *
     * @public
     * @param {Boolean} state whether the member should be lit
     */
    highlightMember(state) {
      const member = this.selectedMember;
      if (!member || !member.highlight) return;
      member.highlight(state, false);
    },
    /**
     * Drops the structure entirely, once it has stopped being one item.
     *
     * Only the member is let go here. Which structure is selected belongs to
     * the selection store, and this used to assign null over the computeds
     * that read it -- writes Vue refuses, so they never did anything; the
     * panel emptied because exploding a structure changes the selection, not
     * because of anything on this line.
     *
     * @public
     */
    clearStructure() {
      this.highlightMember(false);
      this.memberId = null;
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
      // Nothing to copy any more. Every field this used to write -- the
      // primary, the fixtures, the whole typed selection -- is a computed view
      // of the selection store, and a view cannot be stale or be overwritten
      // by whichever channel happened to fire last.
      this.highlightMember(false);
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
