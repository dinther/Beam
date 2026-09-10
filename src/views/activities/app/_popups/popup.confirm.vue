<template>
  <uk-popup
    v-model="state"
    backdrop
    :movable="false"
    cancelable
    :header="{ title }"
    :validate-txt="yes"
    :cancel-txt="no"
    @submit="answer(true)"
  >
    <uk-flex
      col
      :gap="8"
      class="confirm_body"
    >
      <p class="confirm_message">
        {{ message }}
      </p>
      <p
        v-if="detail"
        class="confirm_detail"
      >
        {{ detail }}
      </p>
    </uk-flex>
  </uk-popup>
</template>

<script>
/**
 * @file A yes/no question, asked from anywhere through `plugins/confirm.js`.
 *
 * Mounted once, at the app root beside the error popup, rather than inside the
 * widget that asks. A popup is `position: fixed`, and fixed inside a docked
 * widget is at the mercy of whatever that dock does to its children; the root
 * is the one place nothing can clip it.
 *
 * **Anything but "yes" is no.** Cancel, the close cross and Escape all come
 * through as the popup closing without having been submitted, and the question
 * is answered false. A question left unanswered must never be read as consent.
 */
export default {
  name: 'PopupConfirm',
  compatConfig: {
    MODE: 3,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
    /** The header: what is being decided. */
    title: {
      type: String,
      default: 'Are you sure?',
    },
    /** The question itself. */
    message: {
      type: String,
      default: '',
    },
    /** What it will cost, when that is worth saying separately. */
    detail: {
      type: String,
      default: '',
    },
    /** The button that means yes. */
    yes: {
      type: String,
      default: 'yes',
    },
    /** The button that means no. */
    no: {
      type: String,
      default: 'no',
    },
  },
  emits: ['update:modelValue', 'answer'],
  data() {
    return {
      state: this.modelValue,
      /** Whether this showing has been answered yes, so closing is not a no too. */
      answered: false,
    };
  },
  watch: {
    modelValue(open) {
      this.state = open;
      if (open) this.answered = false;
    },
    state(open) {
      this.$emit('update:modelValue', open);
      // Closed without a yes: that is the answer.
      if (!open && !this.answered) this.answer(false);
    },
  },
  methods: {
    /**
     * @public
     * @param {Boolean} yes
     */
    answer(yes) {
      if (this.answered) return;
      this.answered = true;
      this.$emit('answer', yes);
      this.state = false;
    },
  },
};
</script>

<style scoped>
.confirm_body {
  width: 100%;
  max-width: 420px;
  padding: 16px;
}
.confirm_message {
  font-family: Roboto-Regular;
  font-size: 13px;
  color: var(--secondary-lighter);
  margin: 0;
}
.confirm_detail {
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter-alt);
  margin: 0;
}
</style>
