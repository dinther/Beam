<template>
  <uk-widget
    class="object_widget"
    dockable
    :header="{ title: 'Object', icon: 'object' }"
  >
    <uk-flex
      v-if="!object"
      col
      class="object_widget_body"
    >
      <span class="object_widget_empty">No object selected</span>
    </uk-flex>

    <uk-flex
      v-else-if="!object.isInline"
      col
      :gap="8"
      class="object_widget_body"
    >
      <span class="object_widget_section">Library model</span>
      <span class="object_widget_note">
        {{ object.model }}
      </span>
      <!-- A definition, not a parameter set: what a library model is made of is
           what it is. An imported one is changed in the file it came from; a
           saved shape is changed by making it again under another name. -->
      <span class="object_widget_note">
        A library model is a definition and is not edited here. Make it
        unique to change this one, or edit an imported model in its file.
      </span>
      <!-- The inverse of Save to library, the way un-structure is the inverse
           of making a structure: this placement takes the shape's parameters
           as its own and stops referencing the library. Only for a shape --
           an imported model has only a file, nothing to hand back. -->
      <uk-flex
        v-if="canMakeUnique"
        :gap="8"
      >
        <uk-button
          icon="copy"
          label="make unique"
          title="Detach this one from the library, as if you had just created it"
          @click="makeUnique"
        />
      </uk-flex>
      <!-- Here as well as below: a failed make-unique leaves the widget on this
           view, and the reason has to be somewhere it can be read. -->
      <p
        v-if="message"
        :class="failed ? 'object_widget_warning' : 'object_widget_ok'"
      >
        {{ message }}
      </p>
    </uk-flex>

    <uk-flex
      v-else
      col
      :gap="8"
      class="object_widget_body"
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
          title="Save this shape to the library under its name; it becomes a library model"
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
import confirm from '@/plugins/confirm';
import ObjectParamsForm from './object.params.form.vue';

/**
 * @file Adjusts a created object, and optionally saves it as a template.
 *
 * A created object holds its own parameters in the show, so it can be widened
 * or recoloured at any time -- which is what this is for. Until 2026-08-28
 * creating one wrote a library entry and froze it, so a wider cube meant a
 * second cube and a library full of near duplicates.
 *
 * **Save to library turns this object into a library reference.** Until then
 * it is a bare placement of its kind, and its size and colour are its own to
 * change; saved as "Stage Table", those numbers become part of a definition
 * and the placement can no longer change them -- a definition is never edited,
 * only made again. This replaced the earlier bargain, described below for the
 * record, in which the object stayed inline after saving.
 *
 * **Make unique is the way back** (2026-09-10), for a placement of a library
 * shape: it takes the shape's parameters as its own and is editable again, as
 * if just created, while the library entry stays as it was. The same relation
 * un-structure has to making a structure.
 *
 * **(Superseded) Save to library copies the parameters out; it does not turn this object
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
    /** Whether the library model behind this object is a shape it could own. */
    canMakeUnique() {
      const entry = this.$show.objectLibraryEntry(this.object);
      return !!(entry && entry.primitive);
    },
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
     * Detaches this placement from its library shape. The widget then shows the
     * editable view on its own, because the object is now inline.
     *
     * @public
     * @async
     */
    async makeUnique() {
      if (!this.object) return;
      this.message = '';
      this.failed = false;
      if (!await this.$show.makeObjectUnique(this.object)) {
        this.failed = true;
        this.message = 'The library entry for this object could not be found.';
      }
    },
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

      const name = String(this.object.name);
      let result = null;
      try {
        result = await window.library.createObject(name, primitive);
        // A shape of this name is already in the library. Asked, not refused:
        // replacing it is a real thing to want -- make a library shape unique,
        // change it, save it back -- but it changes every placement of it, in
        // this show and in every other that uses it, so it is never done
        // without a yes.
        if (result && result.exists) {
          const yes = await confirm({
            title: 'Overwrite library entry?',
            message: `"${name}" is already in the object library. Overwrite it with this shape?`,
            detail: `Every placement of "${name}" will change -- in this show, and in any other show that uses it.`,
            yes: 'yes',
            no: 'no',
          });
          if (!yes) {
            this.saving = false;
            return;
          }
          result = await window.library.createObject(name, primitive, { overwrite: true });
        }
      } catch (err) {
        // A throw crosses IPC as a rejection, not as a `reason`, and without
        // this the button would stay disabled on a failure nobody explained.
        this.saving = false;
        this.failed = true;
        this.message = `Could not save to the library: ${err.message}`;
        return;
      }

      this.failed = !(result && result.ok);
      if (this.failed) {
        this.saving = false;
        // The reason matters most when it is a name clash, which is the usual
        // one: the library is keyed by name and will not overwrite silently.
        this.message = (result && result.reason) || 'Could not save to the library.';
        return;
      }
      // Saved means *is* a library model now: the object stops carrying its
      // own parameters and references the entry, so this widget flips to the
      // library view above. The same move a fixture definition makes when it
      // is saved -- a definition is either the show's or the library's.
      const adopted = await this.$show.adoptObjectIntoLibrary(this.object, result.key);
      this.saving = false;
      this.message = adopted
        ? `Saved "${result.name}" to the object library.`
        : `Saved "${result.name}", but the library entry could not be read back.`;
    },
  },
};
</script>

<style scoped>
/*
 * Follows `structure.modifier.widget.vue`, which documents what the widget
 * shell does to a body left to itself: it centres vertically, so a short one
 * floats with padding above and below, and it sets `white-space: nowrap` and
 * clips the overflow, so anything that reads as prose is truncated. Filling the
 * height and opting back into wrapping is what every other tool here does.
 */
.object_widget_body {
  height: 100%;
  width: 100%;
  padding: 8px;
  white-space: normal;
}

.object_widget_section {
  font-family: Roboto-Regular;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-light-alt);
}

.object_widget_empty,
.object_widget_note {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}

.object_widget_warning {
  margin: 0;
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--accent-red);
}

.object_widget_ok {
  margin: 0;
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
}
</style>
