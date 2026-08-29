<template>
  <uk-flex class="fixture_modifier">
    <structure-widget
      v-if="selectedStructure"
      :structure="selectedStructure"
      :selected-member-id="selectedFixture ? selectedFixture.id : null"
      @select-member="selectMember"
      @exploded="clearStructure"
    />
    <position-tool-widget
      v-if="selectedStructure"
      :fixture="selectedStructure"
      title="Structure Position"
    />
    <object-widget
      v-if="selectedObject"
      :object="selectedObject"
    />
    <position-tool-widget
      v-if="selectedObject"
      :fixture="selectedObject"
      title="Object Position"
    />
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
      v-if="!showsOneFixture && !showsManyItems && !selectedGroup && !selectedStructure
        && !selectedObject"
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
import { SCENE_ITEM_KINDS } from '@/models/DMX/scene_item';

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
    };
  },
  computed: {
    /**
     * The fixture the single-fixture widgets edit, or null.
     *
     * From the store, not the route. The route names one thing at most, and
     * router navigation is *asynchronous* -- so pushing `?fixtureId=` for the
     * first of a batch landed after the rest of the selection had been
     * announced and overwrote it with a single item. Selecting three fixtures
     * left the panel believing there was one, and Arrange refused to open.
     *
     * @returns {Object|null}
     */
    selectedFixture() {
      const { primary } = Selection;
      if (!primary || primary.kind !== SCENE_ITEM_KINDS.FIXTURE) return null;
      return this.$show.fixturePool.findFromId(primary.id) || null;
    },
    /**
     * Every fixture in the selection.
     *
     * @returns {Array}
     */
    selectedFixtures() {
      return Selection.ofKind(SCENE_ITEM_KINDS.FIXTURE)
        .map((entry) => this.$show.fixturePool.findFromId(entry.id))
        .filter(Boolean);
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
      const { primary } = Selection;
      if (!primary || primary.kind !== SCENE_ITEM_KINDS.STRUCTURE) return null;
      return this.$show.structures.find((item) => item.uid === primary.uid) || null;
    },
    /**
     * The selected object, or null -- read from the selection store.
     *
     * @returns {Object|null}
     */
    selectedObject() {
      const { primary } = Selection;
      if (!primary || primary.kind !== SCENE_ITEM_KINDS.OBJECT) return null;
      return this.$show.objects.find((item) => item.uid === primary.uid) || null;
    },
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
     * Whether a selection of two or more items is live.
     *
     * Items, not fixtures: three structures are three things to arrange, and
     * counting the fixtures inside them is what put every one of them on a
     * single line.
     *
     * @property {Boolean} showsManyItems
     */
    showsManyItems() {
      return !this.selectedGroup && !this.selectedStructure && this.selectedItems.length > 1;
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
      if (id === null || id === undefined) {
        this.selectedFixture = null;
        this.selectedFixtures = [];
        return;
      }
      const fixture = this.$show.fixturePool.findFromId(id);
      this.selectedFixture = fixture || null;
      this.selectedFixtures = fixture ? [fixture] : [];
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
      if (!this.selectedStructure || !this.selectedFixture) return;
      if (this.selectedFixture.highlight) this.selectedFixture.highlight(state, false);
    },
    /**
     * Drops the structure entirely, once it has stopped being one item.
     *
     * @public
     */
    clearStructure() {
      this.highlightMember(false);
      this.selectedStructure = null;
      this.selectedFixture = null;
      this.selectedFixtures = [];
      this.selectedItems = [];
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
