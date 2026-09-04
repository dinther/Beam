<template>
  <button
    class="uikit_button"
    :style="{ background }"
    :class="{ disabled, toggled, toggleable, square, flat, icon_only: iconOnly }"
    :title="title || label"
    @click.stop="handleClick"
  >
    <uk-icon
      v-if="icon"
      class="uikit_button_icon"
      :name="icon"
    />
    <h4 v-if="!iconOnly">
      {{ label }}
    </h4>
  </button>
</template>

<script>
/**
 * @component Butto customisable button component usable as a toggleable and/or temporary switch.
 * @namespace uikit/inputs/buttons
 * @story Default {"label":"default", "value": false}
 * @story Square {"label":"square", "square": true, "value": false}
 * @story Toggle {"label":"toggle", "toggleable": true, "value": false}
 * @story Icon {"label":"Icon", "toggleable": true, "value": false, "icon":"new"}
 */
export default {
  name: 'UkButton',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Text to be displayed in the button.
     */
    label: {
      type: String,
      default: null,
    },
    /**
     *  Whether the button is disabled or not.
     */
    disabled: Boolean,
    /**
     *  Whether the button is toggleabe (cycle on/off) or not.
     */
    toggleable: Boolean,
    /**
     * Whether alternate "square" styling should be applied
     */
    square: Boolean,
    /**
     * Draws the button with no background at all -- just its glyph.
     *
     * For an icon that expresses a STATE rather than offering an action, where
     * the usual pill reads as a second control sitting beside the real ones.
     * The colour then comes from whatever `color` the caller sets, since the
     * icons are drawn with `fill="currentColor"`.
     */
    flat: Boolean,
    /**
     * Draws the button as a square holding only its icon. The label still has
     * to be given: it becomes the tooltip, which is the only thing telling a
     * user what an icon means.
     */
    iconOnly: Boolean,
    /**
     * Tooltip text, when it should differ from the label.
     */
    title: {
      type: String,
      default: '',
    },
    /**
     * The button's current value. Either true or false.
     */
    modelValue: Boolean,
    /**
     * The button's color. Defaults to the app's teal accent.
     */
    color: {
      type: String,
      default: 'var(--accent-blue)',
    },
    /**
     * uikit-icon name to preceed the button's label.
     */
    icon: {
      type: String,
      default: null,
    },
  },
  emits: ['update:modelValue', 'click'],
  data() {
    return {
      /**
       * Button's toggle state.
       *
       * Read from `modelValue`, which is the prop that exists -- `this.value`
       * named nothing, so a toggle bound to something already on started off
       * looking off, and only righted itself the first time the bound value
       * changed.
       */
      toggled: this.toggleable ? !!this.modelValue : false,
    };
  },
  watch: {
    modelValue(value) {
      if (this.toggleable) {
        this.toggled = value;
      }
    },
  },
  computed: {
    /**
     * The button's own background.
     *
     * `flat` has none. The stylesheet clears it too, but this keeps the inline
     * style honest rather than setting a colour that is then overridden.
     *
     * @returns {String}
     */
    background() {
      if (this.flat) return 'transparent';
      return this.toggled && this.color ? this.color : 'var(--secondary-dark)';
    },
  },
  methods: {
    /**
     * Handle button click.
     *
       */
    handleClick() {
      if (!this.disabled) {
        if (this.toggleable) {
          this.toggled = !this.toggled;
        }
        /**
       * Button input event
       *
       * @property {Boolean} toggled button's toggle state
       */
        this.$emit('click', this.toggled);
        this.$emit('update:modelValue', this.toggled);
      }
    },
  },
};
</script>

<style scoped>
.uikit_button {
  display: flex;
  user-select: none;
  background: var(--secondary-dark);
  height: 20px;
  min-height: 20px;
  min-width: 70px;
  /* max-width: 100px; */
  border-radius: 10px;
  align-items: center;
  justify-content: center;
  text-transform: uppercase;
  padding: 0 14px;
  opacity: .9;
}
.uikit_button:not(.disabled):not(.toggleable){
  background: var(--secondary-light)!important;
}
.uikit_button.toggleable{
  background: var(--secondary-darker);
  opacity: .8;
}
.uikit_button.square{
  border-radius: 0;
}
/* Matches the specificity of the background rule above and comes after it, so
   it wins without an arms race. A plain `.uikit_button.flat` loses: `:not()`
   counts towards specificity, so that rule scores four classes and this would
   score two. */
.uikit_button.flat:not(.disabled):not(.toggleable) {
  background: transparent !important;
  border-radius: 0;
  /* `icon_only` sizes a button 30 x 30 for a toolbar. Flat is a glyph in a
     row, so it takes only the space the glyph needs -- stated here rather than
     by the caller because `icon_only` outranks anything a parent stylesheet
     can say at equal specificity. */
  width: auto;
  min-width: 0;
  height: auto;
  min-height: 0;
  padding: 0;
  opacity: 1;
}
/* Smaller than the toolbar's 18px but not so small that the difference between
   two similar glyphs stops reading. `!important` to match the rule it
   overrides. */
.uikit_button.flat.icon_only .uikit_button_icon {
  width: 16px !important;
  height: 16px !important;
}
.uikit_button.icon_only {
  width: 30px;
  height: 30px;
  min-width: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.uikit_button.icon_only .uikit_button_icon {
  margin-right: 0;
  height: 18px!important;
  width: 18px!important;
}
.uikit_button_label {
  display: table-cell;
  vertical-align: middle;
  text-align: center;
  font-size: 10px;
  color: var(--secondary-lighter);
}
.uikit_button:not(.disabled):hover {
  opacity: 1;
  cursor: pointer;
  transition: background-color .1s ease-in-out;
}
.uikit_button.disabled {
  background: var(--secondary-darker)!important;
  cursor: unset!important;
}
.disabled h4{
  color: var(--secondary-light)!important;
}
.disabled .uikit_button_icon{
  fill: var(--secondary-light)!important;
}
.uikit_button.toggled {
  background: var(--accent-blue);
}
.uikit_button_icon{
  fill: var(--secondary-lighter);
  margin-right:8px;
  height:14px!important;
  width:14px!important
}
</style>
