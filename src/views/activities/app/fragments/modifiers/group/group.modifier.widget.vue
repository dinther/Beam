<template>
  <uk-widget
    class="group_modifier"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="group"
      :gap="8"
      col
      class="group_modifier_body"
    >
      <uk-txt-input
        v-model.lazy="name"
        style="flex: 1"
        label="Name"
      />

      <p class="group_summary">
        {{ group.members.length }}
        {{ group.members.length === 1 ? 'member' : 'members' }}
      </p>

      <p class="group_summary">
        Export mappings
      </p>
      <uk-flex
        wrap
        :gap="4"
        class="group_mappings"
      >
        <uk-checkbox
          v-for="option in mappingOptions"
          :key="option.id"
          :model-value="hasMapping(option.id)"
          :label="option.label"
          @update:model-value="(on) => setMapping(option.id, on)"
        />
      </uk-flex>
      <p class="group_hint">
        Each ticked mapping exports this group again, flattened that way, at the
        same addresses under its own name. Nothing ticked follows the export
        dialog's own choice.
      </p>

      <uk-flex
        :gap="8"
        class="group_actions"
      >
        <uk-button
          icon="save"
          :label="saveLabel"
          :disabled="!group.members.length"
          @click="saveAsStructure"
        />
        <uk-button
          icon="trash"
          label="ungroup"
          @click="ungroup"
        />
      </uk-flex>

      <p class="group_hint">
        Saving keeps the arrangement, not these fixtures: a structure can be
        placed again as a new group.
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { PROJECTION_LABELS } from '@/models/DMX/generic/madmapper_layout';

/** How long the save button confirms for, in ms. */
const SAVE_FEEDBACK_MS = 1500;

export default {
  name: 'GroupModifierWidget',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to the selected group
     */
    group: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      saved: false,
    };
  },
  computed: {
    header() {
      return { title: this.group ? this.group.name : 'Group', icon: 'group' };
    },
    /**
     * Group name, kept unique so two groups cannot be confused in the list.
     *
     * @type {String}
     */
    name: {
      get() {
        return this.group ? this.group.name : '';
      },
      set(value) {
        if (!this.group) return;
        this.group.name = this.$show.uniqueGroupName(value, this.group.id);
      },
    },
    saveLabel() {
      return this.saved ? 'saved' : 'save as structure';
    },
    mappingOptions() {
      return PROJECTION_LABELS;
    },
  },
  methods: {
    /**
     * Whether this group asks for a mapping.
     *
     * @public
     * @param {String} id projection id
     * @returns {Boolean}
     */
    hasMapping(id) {
      return !!this.group && (this.group.mappings || []).includes(id);
    },
    /**
     * Adds or removes a mapping.
     *
     * Replaced rather than mutated so the change reaches Vue through the
     * group's own reactivity, the way the name does.
     *
     * @public
     * @param {String} id projection id
     * @param {Boolean} wanted
     */
    setMapping(id, wanted) {
      if (!this.group) return;
      const current = (this.group.mappings || []).filter((m) => m !== id);
      this.group.mappings = wanted ? [...current, id] : current;
    },
    /**
     * Stores the arrangement for placing again later.
     *
     * @public
     * @async
     */
    async saveAsStructure() {
      if (!this.group) return;
      await this.$show.saveStructure(this.group);
      this.saved = true;
      setTimeout(() => { this.saved = false; }, SAVE_FEEDBACK_MS);
    },
    /**
     * Dissolves the group, leaving its members where they are.
     *
     * @public
     */
    ungroup() {
      if (!this.group) return;
      this.$show.ungroup(this.group);
    },
  },
};
</script>

<style scoped>
.group_modifier_body {
  padding: 8px;
  /* The widget shell sets white-space: nowrap for its single-line rows, and
     clips what overflows. Prose in here has to opt back into wrapping. */
  white-space: normal;
}
.group_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
.group_hint {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter-alt);
  margin: 0;
  /*
   * Wraps to whatever width the buttons give the widget, rather than setting
   * that width itself. A paragraph's natural width is its whole sentence on
   * one line, which would make the widget as wide as the sentence; zero width
   * keeps it out of that calculation and min-width restores it afterwards.
   */
  width: 0;
  min-width: 100%;
}
.group_actions {
  align-items: center;
}
.group_mappings {
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
