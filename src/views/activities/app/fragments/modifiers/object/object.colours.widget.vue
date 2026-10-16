<template>
  <uk-widget
    class="colours_widget"
    dockable
    :header="header"
  >
    <uk-flex
      col
      :gap="6"
      class="colours_body"
    >
      <!-- Over the whole object, textures included: it multiplies every part. -->
      <div class="colours_row">
        <span class="colours_label">Tint</span>
        <uk-colour-input
          :model-value="tintRow.color"
          aria-label="Tint"
          @update:model-value="(value) => setPart('tint', value)"
        />
        <span
          v-if="tintRow.mixed"
          class="colours_note"
        >mixed</span>
        <uk-button
          icon="undo"
          icon-only
          flat
          :disabled="!tintRow.own"
          title="No tint"
          @click="setPart('tint', null)"
        />
      </div>
      <div
        v-for="row in rows"
        :key="row.part"
        class="colours_row"
      >
        <span class="colours_label">{{ labelOf(row.part) }}</span>
        <uk-colour-input
          :model-value="row.color"
          :aria-label="`${labelOf(row.part)} colour`"
          @update:model-value="(value) => setPart(row.part, value)"
        />
        <span
          v-if="row.mixed"
          class="colours_note"
        >mixed</span>
        <uk-button
          icon="undo"
          icon-only
          flat
          :disabled="!row.own"
          title="Back to the model's own colour"
          @click="setPart(row.part, null)"
        />
      </div>
      <uk-flex :gap="8">
        <uk-button
          v-if="variable"
          label="vary"
          :title="objects.length > 1
            ? 'Give each selected figure its own colours'
            : 'Give this figure new colours'"
          @click="vary"
        />
        <uk-button
          v-if="posable"
          label="vary pose"
          :disabled="posing"
          title="Swap each figure for another pose of its kind: standing, or sitting"
          @click="varyPose"
        />
      </uk-flex>
    </uk-flex>
  </uk-widget>
</template>

<script>
/**
 * Colours of library objects, one or several: a tint over the whole object,
 * and the colour of each part -- top, trousers, shoes, skin and hair on a
 * person, or a model's own materials. See `SceneObjects.partsOf`.
 *
 * With several selected, a row shows its colour where they all agree and says
 * "mixed" where they do not; setting it sets it on all of them. Only the parts
 * every selected object has are listed. Vary gives each one its own colours,
 * drawn from palettes per part, where there are palettes.
 */

/** What each part is called here. A part not listed shows its own name. */
const LABELS = {
  top: 'Top', trousers: 'Trousers', shoes: 'Shoes', skin: 'Skin', hair: 'Hair',
};

/** What Vary draws from, per part. Clothing is muted so it does not glow under light. */
const PALETTES = {
  skin: ['#f1d3c2', '#e8b896', '#d39c76', '#b97f5a', '#9a6440', '#7a4a2c', '#5a351f', '#3d2414'],
  hair: ['#1b1410', '#2d1d14', '#4a2e1b', '#6b4226', '#8d5a2b', '#b8864b', '#d8b26e', '#8a8a8a', '#d6d6d6', '#5a1f14'],
  top: ['#2f3a4a', '#5b6b7d', '#7a2b2b', '#2f5a3a', '#cfc8b8', '#1e1e1e', '#4b3b6b', '#9a6a2a', '#3d6b8a', '#b9b9b9', '#6b2f4b', '#6a6a35'],
  trousers: ['#1b1b1d', '#2b3550', '#3a3a3a', '#4a3b2b', '#626262', '#25303f', '#5a4a3a', '#7d7568'],
  shoes: ['#141414', '#2b1d14', '#e6e6e6', '#4a3020', '#3a3a3a', '#6e1d1d'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default {
  name: 'ObjectColoursWidget',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** The selected objects with recolourable parts. */
    objects: {
      type: Array,
      default: () => [],
    },
  },
  data() {
    return {
      /** Bumped after a change: the objects are not reactive. */
      tick: 0,
      /** While Vary pose is swapping models. */
      posing: false,
    };
  },
  computed: {
    header() {
      const n = this.objects.length;
      return { title: n > 1 ? `Colours · ${n} objects` : 'Colours', icon: 'colorwheel' };
    },
    /** Whether any selected object is a figure with a type, standing or sitting. */
    posable() {
      // eslint-disable-next-line no-unused-expressions
      this.tick;
      return this.objects.some((object) => this.figureOf(object));
    },
    /** Whether Vary has palettes for any part listed. */
    variable() {
      return this.rows.some((row) => PALETTES[row.part]);
    },
    /** The tint row: `{ color, mixed, own }`; white where there is none. */
    tintRow() {
      // eslint-disable-next-line no-unused-expressions
      this.tick;
      const values = this.objects.map((object) => object.tint || '#ffffff');
      return {
        color: values[0] || '#ffffff',
        mixed: values.some((v) => v !== values[0]),
        own: this.objects.some((object) => object.tint),
      };
    },
    /**
     * `{ part, color, mixed, own }` for the parts every selected object has,
     * in the first object's order.
     */
    rows() {
      // eslint-disable-next-line no-unused-expressions
      this.tick;
      const first = this.objects[0];
      if (!first) return [];
      return first.parts.filter(({ part }) => this.objects
        .every((object) => object.parts.some((p) => p.part === part))).map(({ part }) => {
        const values = this.objects
          .map((object) => object.parts.find((p) => p.part === part))
          .filter(Boolean);
        return {
          part,
          color: values[0].color,
          mixed: values.some((v) => v.color !== values[0].color),
          own: values.some((v) => v.own),
        };
      });
    },
  },
  methods: {
    labelOf(part) {
      return LABELS[part] || part;
    },
    /**
     * @param {String} part
     * @param {String|null} color `#rrggbb`, or null for the model's own
     */
    setPart(part, color) {
      this.objects.forEach((object) => object.setColors({ [part]: color }));
      this.tick += 1;
    },
    /**
     * A figure's type and gender from its library entry's sidecar, or null.
     *
     * @param {Object} object
     * @returns {Object|null} `{ type, gender }`
     */
    figureOf(object) {
      const entry = this.$show.objectLibraryEntry(object);
      return entry && entry.figure ? entry.figure : null;
    },
    /**
     * Swaps each selected figure for a random other pose of the same type and
     * gender. Where it stands and its colours are kept.
     *
     * @public
     * @async
     */
    async varyPose() {
      this.posing = true;
      await this.$show.preloadObjectLibrary();
      // Each entry is listed under its key and its bare name; once each here.
      const library = [...new Set(Object.values(this.$show.objectLibrary || {}))];
      await Promise.all(this.objects.map((object) => {
        const figure = this.figureOf(object);
        if (!figure) return null;
        const current = String(object.model).toLowerCase();
        const others = library.filter((entry) => entry.figure
          && entry.figure.type === figure.type
          && entry.figure.gender === figure.gender
          && String(entry.key).toLowerCase() !== current);
        if (!others.length) return null;
        const next = pick(others);
        return object.setModel(next.key, next);
      }));
      this.posing = false;
      this.tick += 1;
    },
    /** Each object gets its own draw from every part's palette. */
    vary() {
      this.objects.forEach((object) => {
        const colors = {};
        object.parts.forEach(({ part }) => {
          if (PALETTES[part]) colors[part] = pick(PALETTES[part]);
        });
        object.setColors(colors);
      });
      this.tick += 1;
    },
  },
};
</script>

<style scoped>
/* One width whatever is selected, so the panel does not shift. */
.colours_widget {
  max-width: 260px;
  min-width: 260px;
}
.colours_body {
  height: 100%;
  width: 100%;
  padding: 8px;
  white-space: normal;
}
.colours_row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.colours_label {
  width: 64px;
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
}
.colours_note {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
</style>
