<template>
  <div
    class="uikit_combo"
    @focusout="hideOnLeave"
  >
    <div
      v-if="label"
      :class="{ disabled }"
      class="label"
    >
      {{ label }}
    </div>
    <div
      class="uikit_combo_textbox_wrapper"
      :class="{ disabled }"
    >
      <input
        ref="input"
        v-model="content"
        class="uikit_combo_textbox"
        :disabled="disabled"
        type="text"
        :placeholder="placeholder"
        @keydown.stop
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="pick(highlighted)"
        @keydown.escape="displayed = false"
        @focus="displayed = true"
        @input="typed"
      >
      <span
        class="uikit_combo_button"
        @mousedown.prevent="toggle"
      >
        <uk-icon
          class="uikit_combo_button_icon"
          name="arrow_down"
        />
      </span>
    </div>
    <div
      v-show="displayed && matches.length"
      class="uikit_combo_option_list"
    >
      <div
        v-for="(option, index) in matches"
        :key="option"
        class="uikit_combo_option"
        :class="{ highlighted: index === highlighted }"
        @mousedown.prevent="pick(index)"
        @mousemove="highlighted = index"
      >
        {{ option }}
      </div>
    </div>
  </div>
</template>

<script>
/**
 * @component ComboInput A text input with a list of suggestions under it,
 * narrowed to the options containing what has been typed. What is typed is
 * the value, whether or not it is in the list.
 * @namespace uikit/inputs/textboxes
 * @story Default {"options":["Martin","Robe"], "label":"Manufacturer", "modelValue": "Generic"}
 */
export default {
  name: 'UkComboInput',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /** The input's label */
    label: {
      type: String,
      default: null,
    },
    /** Shown while the box is empty */
    placeholder: {
      type: String,
      default: null,
    },
    /** The text, chosen from the list or typed */
    modelValue: {
      type: String,
      default: '',
    },
    /** What the list offers */
    options: {
      type: Array,
      default: () => [],
    },
    /** Whether the input is disabled */
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  data() {
    return {
      content: this.modelValue || '',
      displayed: false,
      highlighted: 0,
    };
  },
  computed: {
    /**
     * The options containing what has been typed, case blind. Everything,
     * while nothing has been typed.
     *
     * @type {Array}
     */
    matches() {
      const needle = (this.content || '').trim().toLowerCase();
      if (!needle) return this.options;
      return this.options.filter((option) => String(option).toLowerCase().includes(needle));
    },
  },
  watch: {
    modelValue(value) {
      this.content = value || '';
    },
    matches() {
      this.highlighted = 0;
    },
  },
  methods: {
    /**
     * Every keystroke is the value: a manufacturer nobody has listed is still
     * a manufacturer.
     */
    typed() {
      this.displayed = true;
      this.$emit('update:modelValue', this.content);
    },
    /**
     * Takes an option from the list.
     *
     * @param {Number} index into `matches`
     */
    pick(index) {
      const option = this.matches[index];
      if (option === undefined) {
        this.displayed = false;
        return;
      }
      this.content = String(option);
      this.displayed = false;
      this.$emit('update:modelValue', this.content);
    },
    /**
     * Moves the highlight with the arrow keys, opening the list if closed.
     *
     * @param {Number} step
     */
    move(step) {
      if (!this.displayed) {
        this.displayed = true;
        return;
      }
      const count = this.matches.length;
      if (!count) return;
      this.highlighted = (this.highlighted + step + count) % count;
    },
    toggle() {
      if (this.disabled) return;
      this.displayed = !this.displayed;
      if (this.displayed && this.$refs.input) this.$refs.input.focus();
    },
    /**
     * Closes the list when focus leaves the whole control, and not when it
     * moves within it.
     *
     * @param {FocusEvent} event
     */
    hideOnLeave(event) {
      if (event.relatedTarget && this.$el.contains(event.relatedTarget)) return;
      this.displayed = false;
    },
  },
};
</script>

<style scoped>
.uikit_combo {
  position: relative;
  display: flex;
  flex-direction: column;
  user-select: none;
  width: 100%;
}
.uikit_combo_textbox_wrapper {
  display: flex;
  height: 25px;
  border: 1px solid var(--secondary-dark);
}
.uikit_combo_textbox_wrapper:focus-within {
  outline: 1px solid var(--accent-blue) !important;
  outline-offset: -1px;
}
.uikit_combo_textbox {
  border: none;
  background: var(--primary-dark);
  color: var(--secondary-lighter);
  font-size: 10px;
  width: 100%;
  padding: 0 18px 0 5px;
  outline: 0;
}
.uikit_combo_button {
  background: var(--secondary-dark);
  min-width: 14px;
  max-width: 14px;
  height: 100%;
  margin-left: -14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.uikit_combo_button_icon {
  height: 8px !important;
  width: 8px !important;
  fill: var(--secondary-lighter);
  fill-opacity: 0.7;
}
.disabled .uikit_combo_textbox {
  background: var(--secondary-darker);
  color: var(--secondary-light);
}
.uikit_combo_option_list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 1000;
  max-height: 150px;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--primary-dark);
  outline: 1px solid var(--secondary-light);
  box-shadow: 0 5px 10px -2px var(--primary-dark);
}
.uikit_combo_option {
  display: flex;
  align-items: center;
  min-height: 25px;
  padding: 0 5px;
  font-size: 10px;
  color: var(--secondary-lighter);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.uikit_combo_option.highlighted {
  background: var(--secondary-dark);
}
</style>
