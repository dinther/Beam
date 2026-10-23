<template>
  <uk-widget
    class="structure_modifier"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="structure"
      :gap="8"
      col
      class="structure_modifier_body"
    >
      <uk-txt-input
        v-model.lazy="name"
        label="Name"
      />

      <p class="structure_summary">
        {{ structure.members.length }}
        {{ structure.members.length === 1 ? 'item' : 'items' }}
      </p>

      <!-- The patch bay's list and gestures: click, Ctrl, Shift and a band
           from beside the rows. -->
      <uk-list
        band-select
        draggable
        class="structure_members"
        :items="members"
        :highlight-ids="highlightedIds"
        :selected-id="highlightedIds.length === 1 ? highlightedIds[0] : null"
        @select="selectRow"
        @highlight="highlightRows"
        @reorder="reorderMembers"
      />

      <p class="structure_summary">
        Export mappings
      </p>
      <uk-flex
        wrap
        :gap="4"
        class="structure_mappings"
      >
        <uk-checkbox
          v-for="option in mappingOptions"
          :key="option.id"
          :model-value="hasMapping(option.id)"
          :label="option.label"
          @update:model-value="(on) => setMapping(option.id, on)"
        />
      </uk-flex>

      <uk-checkbox
        :model-value="byIsland"
        label="group by island type"
        @update:model-value="setByIsland"
      />

      <p
        v-if="!named"
        class="structure_warning"
      >
        Give it a name before saving it to the library. The name is how it is
        filed and how you find it again, and “{{ structure.name }}” is the one
        it was handed rather than one you chose.
      </p>

      <uk-flex
        :gap="8"
        class="structure_actions"
      >
        <uk-button
          icon="save"
          :label="saveLabel"
          :disabled="!structure.members.length || !named"
          @click="saveToLibrary"
        />
        <uk-button
          icon="fold"
          label="un-structure"
          @click="explode"
        />
      </uk-flex>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { PROJECTION_LABELS, ISLAND_GROUPING } from '@/models/DMX/generic/madmapper_layout';
import { isNamedByUser } from '@/models/DMX/show.model';
import { displayNameOf } from '@/models/DMX/item_naming';
import { continuingRun, refusalMessage } from '@/models/DMX/address_format';
import ViewFilter from '@/models/DMX/view_filter';
import EventBus from '@/plugins/eventbus';

/** Whether the item list shows an item; the addressing order counts these. */
const listed = (item) => !ViewFilter.hides(item);

/** How long the save button confirms for, in ms. */
const SAVE_FEEDBACK_MS = 1500;

export default {
  name: 'StructureModifierWidget',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to the selected structure
     */
    structure: {
      type: Object,
      default: null,
    },
    /**
     * Row ids of the members highlighted in the list: the ones the fixture
     * widgets edit and the 3D view outlines.
     */
    highlightedIds: {
      type: Array,
      default: () => [],
    },
  },
  emits: ['highlight-members', 'exploded'],
  data() {
    return {
      saved: false,
      /**
       * The highlight as it stood before the list cleared it. A plain click
       * clears the highlight and then selects the row, and the select needs
       * to know what was highlighted before the clear.
       */
      beforeClear: null,
      /**
       * Bumped when the members are reordered or readdressed here: neither
       * they nor their addresses are reactive, so the rows are told this way.
       */
      membersTick: 0,
    };
  },
  computed: {
    header() {
      return { title: this.structure ? displayNameOf(this.structure) : 'Structure', icon: 'structure' };
    },
    /**
     * Structure name, kept unique so two cannot be confused in the list.
     *
     * @type {String}
     */
    name: {
      get() {
        return this.structure ? this.structure.name : '';
      },
      set(value) {
        if (!this.structure) return;
        this.$show.renameItem(this.structure, value);
      },
    },
    /**
     * The members as list rows.
     *
     * This is the only place they appear. They are not scene items -- their
     * coordinates are the structure's to set -- so putting them in the patch
     * bay would contradict what the list is for.
     *
     * @property {Array} members
     */
    members() {
      if (!this.structure) return [];
      // eslint-disable-next-line no-unused-expressions
      this.membersTick;
      // A fixture with a patched fixture before it can continue from it.
      const order = this.$show.addressingOrder(listed);
      return this.structure.members.map((member) => {
        const row = { ...member.listable, name: displayNameOf(member), uid: member.uid };
        if (!this.$show.addressedBefore(member, order)) return row;
        return {
          ...row,
          actions: [{
            icon: 'continue',
            small: true,
            title: 'Continue addressing from the fixture above',
            callback: () => this.continueAddressing(member),
          }],
        };
      });
    },
    saveLabel() {
      return this.saved ? 'saved' : 'save to library';
    },
    mappingOptions() {
      return PROJECTION_LABELS;
    },
    /**
     * Whether this structure carries a name somebody gave it.
     *
     * @type {Boolean}
     */
    named() {
      return !!this.structure && isNamedByUser(this.structure.name);
    },
    byIsland() {
      return !!this.structure && this.structure.grouping === ISLAND_GROUPING.ISLAND;
    },
  },
  methods: {
    /**
     * Chooses whether the export cuts this structure by island type.
     *
     * On, each island type -- `Pan Tilt`, `CMY`, `Control` -- becomes a group
     * of its own holding that island of every member, in its own square. Off,
     * each member is a group holding its own islands, which is the default and
     * what a rig at large wants.
     *
     * @public
     * @param {Boolean} wanted
     */
    setByIsland(wanted) {
      if (!this.structure) return;
      this.structure.grouping = wanted ? ISLAND_GROUPING.ISLAND : ISLAND_GROUPING.FIXTURE;
    },
    /**
     * Whether this structure asks for a mapping.
     *
     * @public
     * @param {String} id projection id
     * @returns {Boolean}
     */
    hasMapping(id) {
      return !!this.structure && (this.structure.mappings || []).includes(id);
    },
    /**
     * Adds or removes a mapping.
     *
     * Replaced rather than mutated so the change reaches Vue through the
     * structure's own reactivity, the way the name does.
     *
     * @public
     * @param {String} id projection id
     * @param {Boolean} wanted
     */
    setMapping(id, wanted) {
      if (!this.structure) return;
      const current = (this.structure.mappings || []).filter((m) => m !== id);
      this.structure.mappings = wanted ? [...current, id] : current;
    },
    /**
     * Every member's row id.
     *
     * @returns {Array}
     */
    allIds() {
      return this.members.map((row) => row.id);
    },
    /**
     * A plain click: that member alone, or every member again when it was
     * already the only one.
     *
     * @public
     * @param {Object} row the member's list row
     */
    selectRow(row) {
      if (!row) return;
      const before = this.beforeClear || this.highlightedIds;
      this.beforeClear = null;
      const alone = before.length === 1 && before[0] === row.id;
      this.$emit('highlight-members', alone ? this.allIds() : [row.id]);
    },
    /**
     * Ctrl, Shift and band selections. An empty highlight, from a click
     * beside the rows, means every member.
     *
     * @public
     * @param {Array} rows the highlighted rows
     */
    highlightRows(rows) {
      if (!rows || !rows.length) {
        this.beforeClear = this.highlightedIds;
        this.$emit('highlight-members', this.allIds());
        return;
      }
      this.beforeClear = null;
      this.$emit('highlight-members', rows.map((row) => row.id));
    },
    /**
     * The member a list row stands for.
     *
     * @public
     * @param {Object} row
     * @returns {Object|null}
     */
    memberOf(row) {
      if (!row || !this.structure) return null;
      return this.structure.members.find((member) => member.uid === row.uid) || null;
    },
    /**
     * Moves a dragged row to where it was dropped. Dragging a highlighted row
     * takes every highlighted member, which lands together in its order.
     *
     * @public
     * @param {Object} payload `{ item, target, position }` from the list
     */
    reorderMembers({ item, target, position }) {
      const dragged = this.memberOf(item);
      const anchor = this.memberOf(target);
      if (!dragged || !anchor) return;
      const highlighted = this.highlightedMembers();
      const moving = highlighted.includes(dragged) ? highlighted : [dragged];
      this.structure.reorder(moving, anchor, position);
      this.$show.touch();
      this.membersTick += 1;
    },
    /**
     * The highlighted members, in the structure's order.
     *
     * @public
     * @returns {Array<Object>}
     */
    highlightedMembers() {
      return this.members
        .filter((row) => this.highlightedIds.includes(row.id))
        .map((row) => this.memberOf(row))
        .filter(Boolean);
    },
    /**
     * Starts a member on the channel after the fixture above it, and the
     * highlighted members below it after that, each after the one before.
     *
     * @public
     * @param {Object} member the fixture whose button was clicked
     */
    continueAddressing(member) {
      const highlighted = this.highlightedMembers();
      const others = highlighted.includes(member) ? highlighted : [];
      const targets = continuingRun(member, others, this.$show.addressingOrder(listed));
      const refused = this.$show.continueAddressing(targets, listed);
      if (refused) EventBus.emit('app_error', new Error(refusalMessage(refused)));
      this.membersTick += 1;
    },
    /**
     * Stores this arrangement in the library so it can be placed again.
     *
     * Placing does not happen on its own: what is in the scene is a stamp, and
     * the library only knows about it once it is put there.
     *
     * @public
     * @async
     */
    async saveToLibrary() {
      if (!this.structure) return;
      // The model refuses an unnamed structure as well as the button being
      // disabled, so the confirmation waits on what was actually written.
      if (!await this.$show.saveStructure(this.structure)) return;
      this.saved = true;
      setTimeout(() => { this.saved = false; }, SAVE_FEEDBACK_MS);
    },
    /**
     * Explodes the structure, leaving its contents where they stand.
     *
     * @public
     */
    explode() {
      if (!this.structure) return;
      this.$show.explodeStructure(this.structure);
      this.$emit('exploded');
    },
  },
};
</script>

<style scoped>
.structure_modifier_body {
  /* The widget shell centres its body vertically (`align-items: safe center`),
     which pads a short one top and bottom. Filling the height instead is what
     the other tools do, and it starts the content at the top. */
  height: 100%;
  width: 100%;
  padding: 8px;
  /* The widget shell sets white-space: nowrap for its single-line rows, and
     clips what overflows. Prose in here has to opt back into wrapping. */
  white-space: normal;
  /* Scrolls once the member list is at its minimum. */
  overflow-y: auto;
}
/* Only the member list gives up height; the other rows keep theirs, or they
   shrink below their content and the list draws over them. */
.structure_modifier_body > * {
  flex-shrink: 0;
}
.structure_warning {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--accent-orange, #d08b3c);
  margin: 0;
  /* Wraps to the widget's width rather than setting it. */
  width: 0;
  min-width: 100%;
}
.structure_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
.structure_members {
  /* Takes the space the other rows do not want, rather than a fixed height,
     and scrolls its rows instead of pushing the buttons off the bottom. Four
     rows at least, below which the widget scrolls instead. */
  flex: 1 1 0;
  min-height: 96px;
}
.structure_actions {
  align-items: center;
}
.structure_mappings {
  /* Two rows, filled downwards, so the opposite faces pair up: Front above
     Back, Left above Right, Top above Bottom, and the two unwraps together.
     Column flow rather than a fixed column count keeps it two rows whatever
     the projection list grows to. */
  display: grid;
  grid-template-rows: repeat(2, auto);
  grid-auto-flow: column;
  justify-content: start;
  column-gap: 12px;
}
</style>
