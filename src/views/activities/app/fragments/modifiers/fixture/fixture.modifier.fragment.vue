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
      v-if="showsManyItems"
      :items="selectedItems"
    />
    <h3
      v-if="!showsOneFixture && !showsManyItems && !selectedGroup && !selectedStructure"
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
import StructureWidget from '../structure/structure.modifier.widget.vue';

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
      /**
       * Currently selected structure, when a whole structure is what the pick
       * resolved to. Its own widget is not built yet; this is here so the
       * single-fixture widgets do not stay up showing a stale member.
       */
      selectedStructure: null,
      /**
       * The whole selection as items: a fixture standing on its own, or a
       * structure, each counting once. What Arrange acts on.
       */
      selectedItems: [],
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
  },
  beforeUnmount() {
    this.highlightMember(false);
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
        this.selectedItems = [];
        return;
      }
      try {
        this.selectedFixture = this.$show.fixturePool.getFromId(Number(id));
        // Routing to one fixture *is* a selection of one. Without this a click
        // in the patch bay list would leave a stale multi-selection standing
        // and the single-fixture widgets hidden behind it.
        this.selectedFixtures = [this.selectedFixture];
        this.selectedItems = [this.selectedFixture];
      } catch (err) {
        this.selectedFixture = null;
        this.selectedFixtures = [];
        this.selectedItems = [];
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
      if (!payload) {
        this.highlightMember(false);
        this.selectedFixture = null;
        this.selectedGroup = null;
        this.selectedStructure = null;
        this.selectedFixtures = [];
        this.selectedItems = [];
        return;
      }
      this.highlightMember(false);
      // Resolved by kind. A structure id and a fixture id are different
      // numbering spaces, so asking the pool for both would hand back an
      // unrelated fixture wherever they happened to collide.
      this.selectedItems = (payload.selectedItems || []).map((entry) => (
        entry.kind === 'structure'
          ? this.$show.structures.find((s) => s.id === entry.id)
          : this.$show.fixturePool.findFromId(entry.id)
      )).filter(Boolean);
      // A structure is one item, not the fixtures inside it. Picking one has
      // to clear the fixture selection outright, or the single-fixture widgets
      // stay up editing whichever member was clicked last.
      this.selectedStructure = payload.structureId === undefined
        ? null
        : this.$show.structures.find((s) => s.id === payload.structureId) || null;
      if (this.selectedStructure) {
        this.selectedFixture = null;
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
