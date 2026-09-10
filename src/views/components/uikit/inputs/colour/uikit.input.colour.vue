<template>
  <div class="uikit_colour_input">
    <input
      :value="modelValue"
      type="color"
      class="uikit_colour_input_swatch"
      :aria-label="ariaLabel || label"
      :disabled="disabled"
      @input="(event) => commit(event.target.value)"
    >
    <uk-txt-input
      :key="revision"
      :model-value="modelValue"
      class="uikit_colour_input_hex"
      :label="label"
      :disabled="disabled"
      @update:model-value="commit"
    />
  </div>
</template>

<script>
/** Six hex digits, with or without the hash. */
const LONG = /^#?([0-9a-f]{6})$/i;
/** Three, CSS shorthand: #abc is #aabbcc. */
const SHORT = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/**
 * A colour as `#rrggbb`, or null when the text is not one.
 *
 * @param {String} text
 * @returns {String|null}
 */
function normalise(text) {
  const value = String(text || '').trim();
  const long = value.match(LONG);
  if (long) return `#${long[1].toLowerCase()}`;
  const short = value.match(SHORT);
  if (short) return `#${short.slice(1).map((d) => d + d).join('').toLowerCase()}`;
  return null;
}

/**
 * @component ColourInput A swatch that opens the system colour picker, beside
 * the same colour as hex text.
 * @namespace uikit/inputs
 *
 * The swatch updates as it is dragged. The text commits on Enter or blur, and
 * text that is not a colour is put back rather than stored -- a half-typed
 * `#a8a` would otherwise become the colour of whatever this is editing.
 * Always emits `#rrggbb`, lower case, which is what `<input type="color">`
 * itself produces.
 */
export default {
  name: 'UkColourInput',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** `#rrggbb` */
    modelValue: {
      type: String,
      default: '#000000',
    },
    /** Label over the hex field. */
    label: {
      type: String,
      default: 'Hex',
    },
    /** What a screen reader calls the swatch; the label when not given. */
    ariaLabel: {
      type: String,
      default: null,
    },
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  data() {
    return {
      /** Bumped to throw away text that was not a colour. */
      revision: 0,
    };
  },
  methods: {
    /**
     * Stores a colour, or puts the text back when it is not one.
     *
     * @param {String} text
     */
    commit(text) {
      const colour = normalise(text);
      if (!colour) {
        this.revision += 1;
        return;
      }
      if (colour !== this.modelValue) this.$emit('update:modelValue', colour);
      // Typed as "A8AEB4" and stored as "#a8aeb4": the field shows what is
      // stored, which the prop alone would not refresh when the two are the
      // same colour.
      else if (text !== colour) this.revision += 1;
    },
  },
};
</script>

<style scoped>
.uikit_colour_input {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.uikit_colour_input_swatch {
  width: 48px;
  height: 27px;
  padding: 0;
  border: 1px solid var(--secondary-dark);
  border-radius: 3px;
  background: none;
  cursor: pointer;
}
.uikit_colour_input_swatch:disabled {
  cursor: default;
  opacity: 0.5;
}
.uikit_colour_input_hex {
  width: 90px;
}
</style>
