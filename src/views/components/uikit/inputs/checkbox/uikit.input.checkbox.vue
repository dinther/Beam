<template>
  <div
    class="uikit_checkbox"
    :class="{ disabled }"
  >
    <span
      class="uikit_checkbox_tickbox"
      :class="{ active }"
      @click="toggle()"
    >
      <span class="uikit_checkbox_tickbox_tick">
        <!-- TODO: replace this by a div with svg mask to change color dynamically/clean !-->
        <svg
          width="9"
          height="8"
          viewbox="0 0 9 8"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1 3.85714L3.33333 6L8 1"
            stroke-width="2"
          />
        </svg>
      </span>
    </span>
    <span
      v-if="label != null"
      class="uikit_checkbox_label"
      :class="{ active: active }"
    >
      {{ label }}
    </span>
  </div>
</template>

<script>
/**
 * @component Checkbox A simple checkbox toggle component.
 * @namespace uikit/inputs/toggles
 * @story Default {"value": "Default", "label":"default"}
 * @story Disabled {"value": "Default", "label":"default", "disabled": true}
 */
export default {
  name: 'UkCheckbox',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * The checkbox's value.
     */
    modelValue: {
      type: [Boolean, Number],
      default: false,
    },
    /**
     * Whether the checkbox is disabled or not.
     */
    disabled: Boolean,
    /**
     * Text label to be displayed on the right of the checkbox
     */
    label: {
      type: String,
      default: null,
    },
  },
  emits: ['update:modelValue', 'input'],
  data() {
    return {
      /**
       * Checkbox's activity value
       */
      active: this.modelValue,
    };
  },
  watch: {
    modelValue(val) {
      this.active = val;
    },
  },
  methods: {
    /**
     * Toggle the checkbox activity ON/OFF
     *
       */
    toggle() {
      if (!this.disabled) {
        this.active = !this.active;
        /**
         * Checkbox's activity changed
         *
         * @property {Boolean} active the checkbox's activity value
         */
        this.$emit('input', this.active);
        this.$emit('update:modelValue', this.active);
      }
    },
  },
};
</script>

<style scoped>
.uikit_checkbox {
  display: flex;
  flex-direction: row;
  align-items: center;
  font-family: Roboto-Regular;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  user-select: none;
  width: min-content;
  width: auto;
}
.uikit_checkbox_tickbox {
  /* Same shell as a text field: dark fill, light border. The tick alone
     carries the state, so the box does not change colour when ticked. */
  background: var(--primary-dark);
  border: 1px solid var(--secondary-dark);
  box-sizing: border-box;
  height: 16px;
  width: 16px;
  display: flex;
  align-items: center;
  flex-direction: row;
  cursor: pointer;
  border-radius: 2px;
}
.uikit_checkbox_tickbox_tick {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  stroke: var(--secondary-lighter);
  /* Hidden rather than removed, so ticking cannot shift the layout. An
     unticked box must not show a tick at all: only its colour used to change,
     which read as a checked-but-disabled control. */
  visibility: hidden;
}
.uikit_checkbox_label {
  font-size: 12px;
  padding-left: 8px;
  /* Same tone as every other field label. It used to sit at --secondary-light
     (20% white) until checked, which is the disabled tone, so an unchecked
     option looked unavailable rather than simply off. */
  color: var(--secondary-lighter);
}

.uikit_checkbox_tickbox.active .uikit_checkbox_tickbox_tick {
  visibility: visible;
}
/* The tickbox is a span, so :disabled never matched it; the state comes from
   the disabled class on the wrapper. */
.disabled .uikit_checkbox_tickbox {
  background: var(--secondary-dark);
  opacity: 0.5;
}
.disabled .uikit_checkbox_tickbox {
  cursor: unset !important;
}
</style>
