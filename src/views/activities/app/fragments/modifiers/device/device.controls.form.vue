<template>
  <uk-flex
    v-for="row in rows"
    :key="row.key"
    :gap="8"
    class="control_row"
  >
    <span class="control_label">{{ row.def.label }}</span>

    <uk-select-input
      :model-value="row.modeChoice"
      style="width: 120px"
      :options="row.modeLabels"
      @update:model-value="(v) => setMode(row, v)"
    />

    <!-- Driven: the definition gives where it lives, not what it is worth. -->
    <template v-if="row.state.modeIndex === dmxIndex">
      <uk-num-input
        v-model="row.state.channel"
        class="field"
        label="Rel. channel"
        :min="1"
        :max="512"
      />
      <uk-select-input
        v-model="row.state.bitsIndex"
        style="width: 100px"
        label="Depth"
        :options="bitLabels"
      />
    </template>

    <!-- Nothing to edit when the value is not the profile's to hold: which feed
         a machine is watching belongs to the placement, so a definition can say
         only whether a console picks it. Same fact as not being fixable. -->
    <template v-else-if="row.holdsValue">
      <!-- The caption is not decoration: without it a checkbox rides up on the
           mode select's line while every other editor sits under its own label,
           and the row's name lands beside the state so that "Blank" next to a
           ticked "Showing" reads as a contradiction. -->
      <div
        v-if="row.editor === 'switch'"
        class="field switch_field"
      >
        <div class="label">
          Value
        </div>
        <uk-checkbox
          v-model="row.state.value"
          :label="row.def.type.onLabel"
        />
      </div>
      <uk-num-input
        v-else
        v-model="row.state.value"
        class="field"
        label="Value"
        :min="row.range.min"
        :max="row.range.max"
        :precision="row.def.type.precision"
      />
    </template>
  </uk-flex>
</template>

<script>
import {
  CONTROL_MODE_ORDER, BIT_DEPTH_LABELS, CONTROL_MODES, controlSetFromRecords,
} from '@/models/DMX/device_control';

/**
 * @file One row per controllable parameter: how it is decided, and either its
 * value or where a console addresses it.
 *
 * Every generic fixture is defined the same way -- see `device_control.js` --
 * so every kind gets the same rows rather than a hand-written section each. The
 * kind supplies its parameter definitions and this draws them.
 *
 * **The editor follows from the parameter's type**, which is the point of
 * having types at all: a shutter is a checkbox, and a lens shift is a number
 * bounded by what those optics can do. Writing a plain number field for both
 * meant a definer typing 1 for "open".
 *
 * A parameter whose value belongs to the *placement* -- which feed a machine is
 * watching -- shows no value editor here at all, because this form defines a
 * model of machine and has nothing to say about it beyond who picks it.
 *
 * The row records are edited **in place**. The parent owns them, keyed by
 * parameter, and turns them into a `ControlSet` when it needs the footprint or
 * the profile -- so the object identities never change and nothing has to be
 * copied back.
 */
export default {
  name: 'DeviceControlsForm',
  props: {
    /**
     * The kind's parameter declarations -- `ControlDef` instances. Only the
     * addressable ones get a row: how a laser is fed or how wide a projector's
     * blend is belongs to the placement, not to the definition.
     */
    defs: {
      type: Array,
      required: true,
    },
    /**
     * The profile's envelope, for the ranges that depend on the machine: a
     * zoom runs between this lens's throw ratios and a shift is bounded by
     * these optics.
     */
    params: {
      type: Object,
      default: () => ({}),
    },
    /**
     * The editable record per parameter:
     * `{ key: { modeIndex, value, channel, bitsIndex } }`.
     */
    controls: {
      type: Object,
      required: true,
    },
  },
  computed: {
    bitLabels() { return BIT_DEPTH_LABELS; },
    /** Which mode select index means DMX, rather than spelling 2 everywhere. */
    dmxIndex() { return CONTROL_MODE_ORDER.indexOf(CONTROL_MODES.DMX); },
    /**
     * The records as a set, which is what knows anything about the collection.
     *
     * @type {ControlSet}
     */
    set() { return controlSetFromRecords(this.defs, this.controls, this.params); },
    /**
     * One row per addressable parameter, carrying everything the template needs
     * so that no lookup happens in the markup.
     *
     * @type {Array}
     */
    rows() {
      return this.defs
        .filter((def) => def.addressable && this.controls[def.key])
        .map((def) => {
          const state = this.controls[def.key];
          // The select offers only the modes this parameter may be in, so its
          // index is a position in that list rather than the canonical one the
          // record holds. setMode maps it back.
          const choices = def.modeChoices();
          const at = choices.findIndex((choice) => choice.index === state.modeIndex);
          return {
            key: def.key,
            def,
            state,
            editor: def.type.editor,
            range: def.type.range(this.params),
            modeChoices: choices,
            modeLabels: choices.map((choice) => choice.label),
            modeChoice: at < 0 ? 0 : at,
            // A parameter the profile cannot bake is also one it cannot park:
            // both are the same fact, that the value belongs to the placement.
            holdsValue: def.fixable,
          };
        });
    },
  },
  methods: {
    /**
     * Changes how a parameter is decided.
     *
     * The channel and depth are kept when it stops being driven, so that
     * trying Adjustable and going back does not lose the address someone
     * already chose.
     *
     * @param {Object} row
     * @param {Number} index
     */
    setMode(row, index) {
      const choice = row.modeChoices[Number(index)];
      if (!choice) return;
      row.state.modeIndex = choice.index;
      // Becoming driven drops it on the next free channel, so a fresh one never
      // lands on a byte already in use.
      if (choice.index === this.dmxIndex) {
        row.state.channel = this.set.nextFreeChannel(row.key);
      }
    },
  },
};
</script>

<style scoped>
/* The same rows the create dialog already drew for a laser, so a projector's
   section is not a second look at the same idea. */
.control_row {
  align-items: flex-end;
  margin-bottom: 4px;
}

.control_label {
  width: 96px;
  align-self: center;
  /* global.css sets no font on body, so a bare span falls through to the
     browser default -- a black serif. Name the family and colour, as every
     other label here does. */
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter-alt);
}

.field {
  width: 120px;
}

/* Stacked like every other editor: caption above, control below. */
.switch_field {
  display: flex;
  flex-direction: column;
}
</style>
