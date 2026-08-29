<template>
  <uk-popup
    v-model="state"
    cancelable
    backdrop
    validate-txt="add"
    :valid="valid"
    :header="headerData"
    @submit="create"
  >
    <object-params-form v-model="params">
      <template #row-end>
        <uk-num-input
          v-model="amount"
          class="create_object_amount"
          label="Amount"
          :min="1"
          :max="512"
        />
      </template>
      <template #warning>
        <p
          v-if="!trimmedName"
          class="create_object_warning"
        >
          Give the object a name.
        </p>
      </template>
    </object-params-form>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import ObjectParamsForm, {
  defaultParams,
} from '@/views/activities/app/fragments/modifiers/object/object.params.form.vue';

/**
 * @file Adds a created object to the scene.
 *
 * **This writes nothing to the library.** Until 2026-08-28 it did, and every
 * experiment became a permanent artefact -- a library filling with near
 * identical shapes, and no way to widen one or recolour it without making
 * another. A created object now goes straight into the show carrying its own
 * parameters, stays editable through the object widget, and reaches the library
 * only when the user asks for it with Save to library.
 *
 * So this dialog is a thin wrapper. The fields are `ObjectParamsForm`, shared
 * with the widget that edits them afterwards -- the two are the same fields by
 * definition, and defining them twice guarantees they drift.
 */
export default {
  name: 'CreateObjectPopup',
  compatConfig: {
    MODE: 3,
  },
  components: {
    ObjectParamsForm,
  },
  mixins: [PopupMixin],
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue', 'created'],
  data() {
    return {
      headerData: { title: 'Create object' },
      params: defaultParams(),
      /**
       * How many to place. Every other way of adding to the show asks this --
       * a shape built here is no different, and building one truss leg at a
       * time to make four was the only way to do it.
       */
      amount: 1,
    };
  },
  computed: {
    trimmedName() {
      return (this.params.name || '').trim();
    },
    /**
     * Whether the object may be added.
     *
     * A name, and nothing else. Nothing is written to a shared folder any
     * more, so there is no collision to check for -- two objects in one scene
     * may perfectly well both be called Cube.
     *
     * @returns {Boolean}
     */
    valid() {
      return !!this.trimmedName;
    },
  },
  watch: {
    /**
     * Keeps the parent's flag in step with this dialog's own state.
     *
     * `PopupMixin.state` is a *copy* of `modelValue`, and nothing sends a
     * change back up unless `update()` is called. Every close path -- submit,
     * cancel, the header X, Escape -- sets `state` locally, so without this the
     * parent's flag stayed true after the dialog had gone. The next time the
     * parent was rebuilt, this component was constructed with
     * `state: this.modelValue` -- still true -- and opened on its own before
     * the user had touched anything.
     *
     * Watched rather than emitted from `create()` so that cancelling and
     * closing are covered too, not only the one path that happened to be hit.
     */
    state(open) {
      this.update();
      // Fresh parameters each time it opens. The last object is in the scene
      // and editable there, so carrying its numbers over would only confuse.
      if (open) {
        this.params = defaultParams();
        this.amount = 1;
      }
    },
  },
  methods: {
    /**
     * Hands the parameters to the patch bay, which puts them in the scene.
     *
     * @public
     */
    create() {
      this.state = false;
      /**
       * An object was described.
       *
       * @property {Object} params the shape
       * @property {Number} amount how many to place
       */
      this.$emit('created', {
        params: { ...this.params, name: this.trimmedName },
        amount: this.amount,
      });
    },
  },
};
</script>

<style scoped>
/* The dialog provides the inset the form deliberately does not. Horizontal as
   well as vertical: at `8px 0` the fields ran into both edges of the popup. */
.create_object_form,
:deep(.object_params) {
  padding: 12px 14px;
}

/* Narrow, and the name gives up the width: how many is a two or three digit
   answer and the name is the field worth typing in. */
.create_object_amount {
  width: 90px;
  flex: none;
}

.create_object_warning {
  margin: 0;
  color: var(--accent-red, #d9534f);
  font-size: 12px;
}
</style>
