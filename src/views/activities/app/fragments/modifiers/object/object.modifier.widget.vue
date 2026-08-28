<template>
  <uk-widget
    :header="{ title: 'Object', icon: 'object' }"
    class="object_widget"
  >
    <uk-flex
      v-if="!object"
      col
    >
      <span class="object_widget_empty">No object selected</span>
    </uk-flex>

    <uk-flex
      v-else-if="!object.isInline"
      col
      :gap="8"
    >
      <span class="object_widget_section">Library model</span>
      <span class="object_widget_note">
        {{ object.model }}
      </span>
      <span class="object_widget_note">
        Imported models are edited in the file they came from, not here.
      </span>
    </uk-flex>

    <uk-flex
      v-else
      col
      :gap="8"
    >
      <!-- The very same component the create dialog uses. A created object is
           its parameters, so the fields that make one and the fields that
           adjust one are the same fields -- and defining them twice guarantees
           they drift the first time one gains a row. -->
      <object-params-form v-model="params" />

      <uk-flex :gap="8">
        <uk-button
          icon="export"
          label="save to library"
          :disabled="saving"
          title="Store these parameters as a template to place again later"
          @click="saveToLibrary"
        />
      </uk-flex>

      <p
        v-if="message"
        :class="failed ? 'object_widget_warning' : 'object_widget_ok'"
      >
        {{ message }}
      </p>
    </uk-flex>
  </uk-widget>
</template>

<script>
import ObjectParamsForm from './object.params.form.vue';

/**
 * @file Adjusts a created object, and optionally saves it as a template.
 *
 * A created object holds its own parameters in the show, so it can be widened
 * or recoloured at any time -- which is what this is for. Until 2026-08-28
 * creating one wrote a library entry and froze it, so a wider cube meant a
 * second cube and a library full of near duplicates.
 *
 * **Save to library copies the parameters out; it does not turn this object
 * into a reference to them.** Paul's call, and the same rule structures follow:
 * a stamp, not a block. The alternative would mean clicking Save quietly
 * changed what this object *is*, so that recolouring it afterwards recoloured
 * every object stamped from the same entry.
 *
 * An imported model has no parameters of its own, so it gets a note rather
 * than a form.
 */
export default {
  name: 'ObjectModifierWidget',
  compatConfig: {
    MODE: 3,
  },
  components: {
    ObjectParamsForm,
  },
  props: {
    /** The selected SceneObject, or null. */
    object: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      saving: false,
      message: '',
      failed: false,
    };
  },
  computed: {
    /**
     * The object's parameters, written straight through on every change.
     *
     * The setter rebuilds the geometry rather than storing and waiting for an
     * Apply: there is no undo stack behind these numbers and no preview to
     * keep in step, so the scene is the preview.
     */
    params: {
      get() {
        if (!this.object || !this.object.primitive) return { type: 'cube', size: {}, color: '' };
        return {
          type: this.object.primitive.type,
          name: this.object.name,
          size: { ...(this.object.primitive.size || {}) },
          color: this.object.primitive.color,
        };
      },
      set(value) {
        if (!this.object) return;
        this.message = '';
        if (value.name !== this.object.name) this.object.name = value.name;
        const before = this.object.primitive;
        const changed = before.type !== value.type
          || before.color !== value.color
          || JSON.stringify(before.size || {}) !== JSON.stringify(value.size || {});
        // Only when the shape actually differs: a rename would otherwise tear
        // the geometry down and build it again for nothing.
        if (changed) {
          this.object.setPrimitive({
            type: value.type,
            size: value.size,
            color: value.color,
          });
        }
      },
    },
  },
  watch: {
    object() {
      this.message = '';
      this.failed = false;
    },
  },
  methods: {
    /**
     * Writes these parameters into the object library as a template.
     *
     * @public
     * @async
     */
    async saveToLibrary() {
      if (!this.object || !this.object.primitive) return;
      if (!window.library || !window.library.createObject) {
        this.failed = true;
        this.message = 'The object library is not available.';
        return;
      }
      this.saving = true;
      this.message = '';
      // Plain data, not the live object. A SceneObject is reactive, so reading
      // a nested value off it hands back a Vue Proxy -- and IPC serialises with
      // structuredClone, which refuses a Proxy outright: "Object could not be
      // cloned". The round trip flattens it to what the descriptor is anyway,
      // numbers and strings.
      const primitive = JSON.parse(JSON.stringify({
        type: this.object.primitive.type,
        size: this.object.primitive.size || {},
        color: this.object.primitive.color,
      }));

      let result = null;
      try {
        result = await window.library.createObject(String(this.object.name), primitive);
      } catch (err) {
        // A throw crosses IPC as a rejection, not as a `reason`, and without
        // this the button would stay disabled on a failure nobody explained.
        this.saving = false;
        this.failed = true;
        this.message = `Could not save to the library: ${err.message}`;
        return;
      }

      this.saving = false;
      this.failed = !(result && result.ok);
      // The reason matters most when it is a name clash, which is the usual
      // one: the library is keyed by name and will not overwrite silently.
      this.message = this.failed
        ? (result && result.reason) || 'Could not save to the library.'
        : `Saved "${result.name}" to the object library.`;
    },
  },
};
</script>

<style scoped>
.object_widget_section {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.6;
}

.object_widget_empty,
.object_widget_note {
  font-size: 12px;
  opacity: 0.7;
}

.object_widget_warning {
  margin: 0;
  color: var(--accent-red, #d9534f);
  font-size: 12px;
}

.object_widget_ok {
  margin: 0;
  font-size: 12px;
  opacity: 0.8;
}
</style>
