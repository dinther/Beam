<template>
  <div
    class="uikit_num_input"
    :class="{ disabled: disabled }"
  >
    <div
      v-if="label"
      :class="{ disabled }"
      class="label"
    >
      {{ label }}
    </div>
    <div
      class="uikit_num_input_textbox_wrapper"
      :class="{color: color !== null}"
      :style="{
        boxShadow: !disabled && color
          ? `inset 0 -2px 0 color-mix(in srgb,${color} 55%,#0000)`
          : ''
      }"
    >
      <input
        ref="field"
        v-model="content"
        class="uikit_num_input_textbox"
        :class="{ dragging }"
        :disabled="disabled"
        :placeholder="placeholder"
        @pointerdown="startDrag"
        @wheel="onWheel"
        @keydown.up="incrementValue"
        @keydown.down="decrementValue"
        @keydown.stop
        @blur="updateValue"
        @keydown.enter="updateValue"
        @input="
          (v) => {
            if (autoUpdate) updateValue(v);
          }
        "
      >
    </div>
  </div>
</template>

<script>
/**
 * @component NumeralInput text input restricted to number-only values.
 * Values may be incremented/decremented by clicking on  the helper arrows
 * and/or by hitting the UP/DOWN arrow keys.
 * @namespace uikit/inputs/textboxes
 * @story Default {"value": 10, "label":"default", "min": 0, "max":100}
 */
/**
 * Pixels of drag per step of the value.
 *
 * Fifty is the three.js editor's feel and it travels well: a whole-number
 * field moves one a fifty-pixel pull, a two-decimal field moves one hundredth.
 *
 * @constant {Number}
 */
const PIXELS_PER_STEP = 50;

/** The same travel, a tenth of the value, while Alt is held. */
const FINE_PIXELS_PER_STEP = 500;

/**
 * The largest single pointer movement treated as a real one, in pixels.
 *
 * Generous for a hand and impossible for a warp. See `dragMove`.
 *
 * @constant {Number}
 */
const MAX_PLAUSIBLE_MOVE = 250;

export default {
  name: 'UkNumInput',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * The numeral input's text label value
     */
    label: {
      type: String,
      default: null,
    },
    /**
     * The numeral input's placeholder text
     */
    placeholder: {
      type: String,
      default: null,
    },
    /**
     * The numeral input's minimum value
     */
    min: {
      type: [Number, String],
      default: 0,
    },
    /**
     * The numeral input's maximum value
     */
    max: {
      type: [Number, String],
      default: 100000,
    },
    /**
     * The numeral input's decimal precision
     */
    precision: {
      type: Number,
      default: 0,
    },
    /**
     * How much one step of drag, wheel or arrow key moves the value.
     *
     * Separate from `precision`, which was doing both jobs and could not. A
     * position field showing one decimal had a step of 0.1 *and* a resolution
     * of 0.1, so holding Alt asked for 0.01 and the rounding put it straight
     * back: ten times the mouse travel for the same steps.
     *
     * Left null it is one unit of the precision, so every existing field
     * behaves exactly as it did. A field wanting fine control states both --
     * `:precision="2" :step="0.1"` drags in tenths and holds hundredths.
     *
     * @type {Number}
     */
    step: {
      type: Number,
      default: null,
    },
    /**
     * The actual numeral input value
     */
    modelValue: {
      type: [Number, String],
      default: 0,
    },
    /**
     * Whether or not the input should be disabeld
     */
    disabled: Boolean,
    /**
     * Apply aleternative color styling
     */
    color: {
      type: String,
      default: null,
      // default: 'var(--secondary-dark)',
    },
    /**
     * Whether value should be automatically updated on each keystroke or not
     * value is updated on input blur or keydown "enter" otherwise
     */
    autoUpdate: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue', 'input'],
  data() {
    return {
      /**
       * Numeral input's value (reactive)
       */
      content: this.modelValue,
      /** Whether a drag is under way, for the cursor and the styling. */
      dragging: false,
    };
  },
  computed: {
    /**
     * How much one step moves the value.
     *
     * @type {Number}
     */
    stepSize() {
      const wanted = Number(this.step);
      return Number.isFinite(wanted) && wanted > 0
        ? wanted
        : parseFloat(10 ** -this.precision);
    },
  },
  watch: {
    modelValue(value) {
      this.content = parseFloat(value);
      this.updateValue(false);
    },
  },
  beforeMount() {
    if (this.default != null) {
      this.updateValue();
    }
    if (this.label == null) {
      this.hasLabel = false;
    } else {
      this.hasLabel = true;
    }
  },
  mounted() {
    if (this.default != null) {
      this.content = this.modelValue;
    }
    if (this.label == null) {
      this.hasLabel = false;
    } else {
      this.hasLabel = true;
    }
    this.updateValue(false);
  },
  beforeUnmount() {
    // A drag that outlived the component would leave a window listener behind
    // and the pointer locked with nothing to write to.
    if (this.drag) this.dragEnd();
  },
  methods: {
    /**
     * Nudges the value with the wheel, while the pointer is over the field.
     *
     * On hover rather than only when focused, because reaching for the wheel
     * over a number is a reflex and stopping to click first is the sort of
     * friction this control exists to remove.
     *
     * The cost is real and worth stating: a panel that scrolls will not scroll
     * while the pointer happens to be over one of its numbers, and a stray
     * wheel there edits a value instead. Blender and Unity make the same
     * trade; the undo history is what makes it survivable.
     *
     * @public
     * @param {WheelEvent} event
     */
    onWheel(event) {
      if (this.disabled) return;
      // Kept off the panel behind it, and this is why the listener cannot be
      // passive -- Vue attaches it non-passive unless asked otherwise.
      event.preventDefault();
      // A notch is a step; Alt is a tenth of one, matching the drag. On a
      // field of whole numbers there is no tenth to give, so Alt does nothing
      // there -- the precision is the field's resolution, not a suggestion.
      const scale = event.altKey ? 0.1 : 1;
      const direction = event.deltaY < 0 ? 1 : -1;
      this.content = (parseFloat(this.content) || 0) + direction * this.stepSize * scale;
      this.updateValue(true);
    },
    /**
     * Begins a possible drag on the number.
     *
     * Possible, not certain: a plain click still has to put the caret in the
     * field and let the value be typed, so nothing is claimed here. The drag
     * only starts once the pointer has actually moved, and only then does the
     * pointer get locked.
     *
     * @public
     * @param {PointerEvent} event
     */
    startDrag(event) {
      if (this.disabled || event.button !== 0) return;
      this.drag = {
        from: Number(this.content) || 0,
        distance: 0,
        started: false,
      };
      this.onDragMove = this.dragMove.bind(this);
      this.onDragEnd = this.dragEnd.bind(this);
      window.addEventListener('pointermove', this.onDragMove);
      window.addEventListener('pointerup', this.onDragEnd);
    },
    /**
     * Turns pointer movement into a value.
     *
     * Right and up both raise it, which is what the three.js editor does and
     * what a hand expects from a field it is scrubbing.
     *
     * The pointer is locked once a drag is real, so the cursor stops existing
     * and the movement stops caring where the window ends -- a long drag on a
     * value with a wide range is otherwise over the moment the mouse reaches
     * the edge of the screen. `movementX` and `movementY` read the same either
     * way, which is why the arithmetic does not change when the lock lands.
     *
     * @public
     * @param {PointerEvent} event
     */
    dragMove(event) {
      if (!this.drag) return;
      // A warp is not a gesture. Locking or unlocking the pointer -- or the
      // window changing size under it -- lands as one enormous delta, and a
      // hand at sixty frames a second does not move a thousand pixels between
      // two of them. Measured at 1159 when Alt summoned the Windows menu bar
      // mid-drag; that is now removed, but a resize can come from anywhere and
      // one bogus event should not throw a fixture across the room.
      if (Math.abs(event.movementX) > MAX_PLAUSIBLE_MOVE
        || Math.abs(event.movementY) > MAX_PLAUSIBLE_MOVE) return;
      this.drag.distance += event.movementX - event.movementY;

      if (!this.drag.started) {
        // A couple of pixels of slop, so a click that trembles is still a
        // click and still gets to focus the field.
        if (Math.abs(this.drag.distance) < 2) return;
        this.drag.started = true;
        this.dragging = true;
        const { field } = this.$refs;
        if (field) {
          field.blur();
          if (field.requestPointerLock) {
            // Newer Chromium answers with a promise and rejects when the
            // gesture is not accepted; the drag still works unlocked.
            const locking = field.requestPointerLock();
            if (locking && locking.catch) locking.catch(() => {});
          }
        }
      }

      // Alt is the fine control, the way it is on a MadMapper slider: the same
      // travel covers a tenth of the range.
      const perStep = event.altKey ? FINE_PIXELS_PER_STEP : PIXELS_PER_STEP;
      this.content = this.drag.from + (this.drag.distance / perStep) * this.stepSize;
      this.updateValue(true);
    },
    /**
     * Ends the drag, and lets a click be a click.
     *
     * @public
     */
    dragEnd() {
      window.removeEventListener('pointermove', this.onDragMove);
      window.removeEventListener('pointerup', this.onDragEnd);
      if (this.drag && this.drag.started) {
        if (document.pointerLockElement) document.exitPointerLock();
      } else if (this.$refs.field) {
        // Never moved: this was a click, so put the caret where it was asked
        // for and select the value ready to be typed over.
        this.$refs.field.select();
      }
      this.drag = null;
      this.dragging = false;
    },
    /**
     * Increments actual value by one precision unit.
     *
     */
    incrementValue() {
      const increment = parseFloat(this.content) + this.stepSize;
      if (increment <= this.max && !this.disabled) {
        this.content = increment.toFixed(this.precision);
        this.updateValue(true);
      }
    },
    /**
     * Decrements value actual value by one precision unit.
     *
     */
    decrementValue() {
      const decrement = parseFloat(this.content) - this.stepSize;
      if (decrement >= this.min && !this.disabled) {
        this.content = decrement.toFixed(this.precision);
        this.updateValue(true);
      }
    },
    /**
     * Updates input value
     *
     * @param {Boolean} doEmit whether or not to emit changes back to parent element.
     */
    updateValue(doEmit = true) {
      // Parsed as a number and kept as one. This used to run through
      // `.toFixed()` first, which returns a *string* -- so `Number.isNaN(val)`
      // was asking whether the string "NaN" was the number NaN, which it never
      // is. An empty or unparseable field therefore sailed past the guard and
      // emitted a real NaN, which reached fixture positions and, through
      // JSON.stringify, was written to the show file as null. A fixture with a
      // null position has a NaN world matrix and simply stops being drawn.
      const parsed = parseFloat(this.content);
      const min = parseFloat(this.min);
      const max = parseFloat(this.max);
      // Nothing usable typed: fall back to zero, or to whichever end of the
      // range is nearest it when zero is out of bounds.
      const fallback = Math.min(Math.max(0, min), max);
      // Clamped both ways. Under-range used to land on zero rather than on the
      // minimum whenever the minimum was negative, so -2000 in a field ranging
      // to -1000 became 0 instead of -1000.
      const value = Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, min), max);

      this.content = value.toFixed(this.precision);
      if (doEmit) {
        /**
         * Input value changed
         *
         * @property {Number} content Parsed and precision limited input value
         */
        this.$emit('update:modelValue', parseFloat(Number(this.content).toFixed(this.precision)));
        this.$emit('input', parseFloat(Number(this.content).toFixed(this.precision)));
      }
    },
  },
};
</script>

<style scoped>
.uikit_num_input {
  display: flex;
  flex-direction: column;
  user-select: none;
  width: fit-content;
}

.uikit_num_input_textbox_wrapper {
  display: flex;
  user-select: none;
  width: 100%;
}
.uikit_num_input_textbox_wrapper:not(.color):focus-within {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}

.uikit_num_input_textbox_wrapper.color:focus-within {
  outline: 1px solid var(--secondary-light);
  outline-offset: -1px;
}
.uikit_num_input_textbox {
  font-family: Roboto-Regular;
  border: none;
  background: transparent;
  /* Brighter than the surrounding text on purpose: a number in this app is
     something to read at a glance and to grab, not a label. A field given a
     colour -- the axis fields in the position tool -- wears it here instead,
     so an X field reads as X. */
  color: var(--accent-teal);
  font-size: 12px;
  display: flex;
  width: 100%;
  padding: 0;
  -moz-appearance: textfield;
  text-align: center;
  /* The value is a thing you pull. Only while it is not being typed into:
     once the caret is in, it is text again. */
  cursor: ns-resize;
}
.uikit_num_input_textbox:focus {
  cursor: text;
  /* Being typed into is the one state that wants a field around it. */
  background: var(--primary-dark);
}
.uikit_num_input_textbox.dragging {
  cursor: ns-resize;
}
.uikit_num_input_textbox:disabled {
  cursor: default;
}
.uikit_num_input_textbox_wrapper {
  display: flex;
  height: 25px;
  /* No box until it is being typed into. A number in a panel is something to
     read and to grab, and a border round every one of them is most of what
     makes a page of them look like a form to fill in rather than values to
     work with. The space is still reserved -- transparent, not absent -- so
     nothing shifts when the field takes focus. */
  border: 1px solid transparent;
}
.uikit_num_input_textbox_wrapper:hover:not(:focus-within) {
  /* Just enough to say it is a thing you can take hold of. The cursor is the
     real affordance; this only confirms what is under the pointer. */
  background: var(--primary-dark-alt);
}
.uikit_num_input_textbox_wrapper:focus-within {
  border-color: var(--secondary-dark);
}
/* An axis field is marked by a rule under it and by nothing else. Colouring
   the value and the label as well was tried and is too much: every number in
   the app reads as a value first, and making some of them red or green says
   they are a different *kind* of thing rather than the same thing on another
   axis. The rule carries the identity without competing with what the field
   is for, and it is also the only one that survives focus -- the value goes
   dark behind the caret the moment it is typed into. */
.uikit_num_input_button {
  display: flex;
  background: var(--secondary-dark);
  width: 14px;
  align-items: center;
  flex-direction: column;
  cursor: pointer;
  padding: 1px 0;
}
.disabled .uikit_num_input_button {
  background: var(--secondary-dark);
}
.disabled .uikit_num_input_button_icon {
  fill: var(--secondary-light);
}
.uikit_num_input_button_section {
  height: 50%;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color .2s;
}
.uikit_num_input_button_section:hover{
  background-color: var(--secondary-dark);
}
.uikit_num_input_button_icon {
  height: 8px !important;
  width: 8px !important;
  fill: var(--secondary-lighter);
  fill-opacity: 0.7;
}
.uikit_num_input_textbox::-webkit-inner-spin-button,
.uikit_num_input_textbox::-webkit-outer-spin-button {
  -webkit-appearance: none;
  -moz-appearance: none;
}
.uikit_num_input_textbox:focus {
  outline: none;
}
.uikit_num_input_textbox::placeholder {
  font-size: 12px;
  color: var(--secondary-light);
}
.disabled .uikit_num_input_textbox {
  background: var(--secondary-darker);
  color: var(--secondary-light);
}
.disabled:focus-within {
  outline: none !important;
}
</style>
