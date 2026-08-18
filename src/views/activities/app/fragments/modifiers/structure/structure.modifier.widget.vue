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

      <uk-list
        class="structure_members"
        :items="members"
        :selected-id="selectedMemberId"
        @select="displayMember"
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

      <uk-flex
        :gap="8"
        class="structure_actions"
      >
        <uk-button
          icon="save"
          :label="saveLabel"
          :disabled="!structure.members.length"
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
import { PROJECTION_LABELS } from '@/models/DMX/generic/madmapper_layout';

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
     * Which member is currently showing its own widgets, if any.
     */
    selectedMemberId: {
      type: Number,
      default: null,
    },
  },
  emits: ['select-member', 'exploded'],
  data() {
    return {
      saved: false,
    };
  },
  computed: {
    header() {
      return { title: this.structure ? this.structure.name : 'Structure', icon: 'structure' };
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
        this.structure.name = this.$show.uniqueStructureName(value, this.structure.id);
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
      return this.structure.members.map((member) => member.listable);
    },
    saveLabel() {
      return this.saved ? 'saved' : 'save to library';
    },
    mappingOptions() {
      return PROJECTION_LABELS;
    },
  },
  methods: {
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
     * Routes to a member so its own widgets open.
     *
     * Selecting one reaches its patching -- a fixture inside a truss still
     * needs a DMX address -- while the position tool locks itself, because the
     * structure is what places it.
     *
     * @public
     * @param {Object} item the member's list row
     */
    displayMember(item) {
      if (!item) return;
      // Clicking the picked member again lets go of it, which is the only way
      // back to the structure's own fields without leaving the structure.
      this.$emit('select-member', item.id === this.selectedMemberId ? null : item.id);
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
      await this.$show.saveStructure(this.structure);
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
}
.structure_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
.structure_members {
  /* Takes the space the other rows do not want, rather than a fixed height:
     min-height lets it shrink below its content so it scrolls instead of
     pushing the buttons off the bottom. */
  flex: 1;
  min-height: 0;
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
