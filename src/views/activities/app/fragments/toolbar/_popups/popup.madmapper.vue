<template>
  <uk-popup
    v-model="state"
    :valid="!!fixtureCount"
    :header="headerData"
    @submit="exportLayout"
    @input="update()"
  >
    <uk-flex
      col
      :gap="8"
      class="layout_export"
    >
      <uk-select-input
        v-model="projectionIndex"
        label="Flatten by"
        :options="projectionNames"
      />

      <p class="layout_summary">
        {{ fixtureCount }} patched
        {{ fixtureCount === 1 ? 'fixture' : 'fixtures' }},
        {{ groupCount }} {{ groupCount === 1 ? 'group' : 'groups' }}
      </p>

      <p class="layout_hint">
        {{ hint }}
      </p>

      <uk-flex
        v-if="cameraView"
        :gap="8"
        center-v
      >
        <uk-checkbox
          v-model="usePerspective"
          label="Perspective"
        />
        <uk-num-input
          v-if="usePerspective"
          v-model="eyeDistance"
          class="field"
          label="Eye (radii)"
          :min="1.1"
          :max="20"
          :step="0.1"
        />
      </uk-flex>

      <p
        v-if="cameraView && usePerspective"
        class="layout_hint"
      >
        Flattening along an axis loses anything lying on it, so a bar aimed at
        the view keeps its pixels but has nowhere to put them. A camera at a
        finite distance has no such direction: bring the eye close and the near
        face opens out while the far one nests inside it.
      </p>

      <p
        v-if="edgeOn.length"
        class="layout_warning"
      >
        {{ edgeOn.length }}
        {{ edgeOn.length === 1 ? 'fixture points' : 'fixtures point' }}
        straight at this view and cannot be drawn at its real angle:
        {{ edgeOn.slice(0, 4).join(', ') }}{{ edgeOn.length > 4 ? '…' : '' }}.
        Exported at a token length so nothing is lost, but worth placing by
        hand or choosing another view.
      </p>

      <uk-checkbox
        v-model="withDefinitions"
        label="Also write fixture definitions"
      />

      <p class="layout_hint">
        MadMapper resolves a layout's fixtures by name, so the definitions
        have to be imported before the layout that refers to them.
        {{ definitionCount }}
        {{ definitionCount === 1 ? 'definition' : 'definitions' }} in this show.
      </p>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import {
  buildMadMapperLayout,
  PROJECTION_LABELS,
  PROJECTIONS,
  edgeOnFixtures,
  isCameraView,
} from '@/models/DMX/generic/madmapper_layout';
import { buildMadMapperLibrary, showDefinitions } from '@/models/DMX/generic/madmapper';

/** What each choice does to the rig, in one line. */
const HINTS = {
  [PROJECTIONS.FRONT]: 'As seen from the front. Fixtures behind others land on top of them.',
  [PROJECTIONS.BACK]: 'As seen from behind. Fixtures behind others land on top of them.',
  [PROJECTIONS.LEFT]: 'As seen from the left. Fixtures behind others land on top of them.',
  [PROJECTIONS.RIGHT]: 'As seen from the right. Fixtures behind others land on top of them.',
  [PROJECTIONS.TOP]: 'A plan view. Fixtures above others land on top of them.',
  [PROJECTIONS.BOTTOM]: 'A plan view from below. Fixtures below others land on top of them.',
  [PROJECTIONS.CYLINDRICAL]:
    'Unrolled about the vertical axis, so content travels around the rig rather than through it. Nothing overlaps.',
  [PROJECTIONS.SPHERICAL]:
    'Unrolled by longitude and latitude, which suits a rig shaped roughly like a ball. Nothing overlaps.',
};

export default {
  name: 'UkPopupMadmapper',
  mixins: [PopupMixin],
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  data() {
    return {
      headerData: { title: 'Export layout for MadMapper', icon: 'export' },
      projectionIndex: 0,
      withDefinitions: true,
      usePerspective: false,
      /** Eye distance from the rig's centre, in radii. */
      eyeDistance: 1.3,
      projectionNames: PROJECTION_LABELS.map((p) => p.label),
    };
  },
  computed: {
    projection() {
      return (PROJECTION_LABELS[this.projectionIndex] || PROJECTION_LABELS[0]).id;
    },
    hint() {
      return HINTS[this.projection] || '';
    },
    cameraView() {
      return isCameraView(this.projection);
    },
    /**
     * Eye settings, or null when this view is flattened along an axis.
     *
     * @type {Object|null}
     */
    perspective() {
      return this.cameraView && this.usePerspective
        ? { distance: Number(this.eyeDistance) || 1.3 }
        : null;
    },
    /**
     * Fixtures that will be written. An unpatched one has no address to carry,
     * so it would arrive in MadMapper as a shape driving nothing.
     *
     * @type {Number}
     */
    fixtureCount() {
      return this.exportable.length;
    },
    /**
     * Patched fixtures, the only ones either file can describe.
     *
     * @type {Array}
     */
    exportable() {
      return this.$show.fixturePool.fixtures.filter((f) => f.channels && f.channels.length);
    },
    /**
     * The definitions this show needs, and the names a layout must quote.
     *
     * Both files come from this one result, so a fixture cannot end up called
     * one thing in the library and another in the layout.
     *
     * @type {Object}
     */
    definitions() {
      return showDefinitions(this.exportable, (slug) => this.$show.manufacturerName(slug));
    },
    definitionCount() {
      return this.definitions.definitions.length;
    },
    /**
     * Fixtures this view sees end-on, which it cannot honestly represent.
     *
     * @type {Array}
     */
    edgeOn() {
      return edgeOnFixtures(this.exportable, this.projection, this.perspective);
    },
    groupCount() {
      return (this.$show.groups || []).filter((g) => (g.members || []).length).length;
    },
  },
  methods: {
    /**
     * Writes the scene as a MadMapper fixture layout.
     *
     * @public
     * @async
     */
    async exportLayout() {
      // Closed before the save dialog opens, rather than after it returns:
      // `close` clears the parent's flag as well as this one, and leaving it
      // set meant the popup came straight back every time.
      this.close();
      if (!window.fileExport) return;
      const { definitions, nameOf } = this.definitions;
      const svg = buildMadMapperLayout({
        fixtures: this.exportable,
        groups: this.$show.groups,
        projection: this.projection,
        definitionName: nameOf,
        perspective: this.perspective,
      });
      if (!svg) return;
      const show = (this.$show.name || 'layout').replace(/[<>:"/\\|?*]/g, ' ').trim();
      // Definitions first: MadMapper resolves a layout's fixtures by name, so
      // they have to exist before the layout that quotes them is read.
      if (this.withDefinitions) {
        const contents = buildMadMapperLibrary(definitions);
        if (contents) {
          await window.fileExport.save({
            contents,
            defaultName: `${show} fixtures.mmfl`,
            startIn: 'madmapperFixtures',
            title: 'Export fixture definitions (import these first)',
            filters: [{ name: 'MadMapper fixtures', extensions: ['mmfl'] }],
          });
        }
      }

      await window.fileExport.save({
        contents: svg,
        defaultName: `${show} ${this.projection}${this.perspective ? ' perspective' : ''}.svg`,
        startIn: 'madmapperFixtures',
        title: 'Export layout for MadMapper',
        filters: [{ name: 'SVG fixture layout', extensions: ['svg'] }],
      });
    },
  },
};
</script>

<style scoped>
.layout_export {
  padding: 16px;
  width: 340px;
  white-space: normal;
}
.layout_warning {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--accent-orange, #d08b3c);
  margin: 0;
  width: 0;
  min-width: 100%;
}
.layout_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
.layout_hint {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  color: var(--secondary-lighter-alt);
  margin: 0;
  /* Wraps to the popup's width rather than setting it: a paragraph's natural
     width is its whole sentence on one line. */
  width: 0;
  min-width: 100%;
}
</style>
