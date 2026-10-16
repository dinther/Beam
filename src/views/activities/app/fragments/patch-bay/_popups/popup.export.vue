<template>
  <uk-popup
    v-model="state"
    :valid="sheet ? sheetAnything : !!fixtureCount"
    :header="headerData"
    @submit="submit"
    @input="update()"
  >
    <uk-flex
      col
      :gap="8"
      class="layout_export"
    >
      <!-- What the items are written as; each target brings its own options below. -->
      <uk-select-input
        v-model="applicationIndex"
        label="Export to"
        :options="applicationNames"
      />

      <patch-sheet-options
        v-if="sheet"
        ref="sheetOptions"
        :scope="sheetScope"
        @change="sheetChange"
      />

      <template v-else>
        <uk-select-input
          v-model="protocolIndex"
          label="MadMapper is driving"
          :options="protocolNames"
        />

        <p class="layout_hint">
          {{ protocolHint }}
        </p>

        <uk-select-input
          v-model="projectionIndex"
          label="Default mapping"
          :options="projectionNames"
        />

        <p class="layout_hint">
          Used for groups and structures that tick no mapping of their own, and
          for fixtures in neither. Their own choices are made in their widgets,
          and each may ask for several.
        </p>

        <uk-select-input
          v-model="squaresIndex"
          label="Squares"
          :options="squareNames"
        />

        <p class="layout_hint">
          {{ squaresHint }}
        </p>

        <p class="layout_summary">
          {{ fixtureCount }} patched
          {{ fixtureCount === 1 ? 'fixture' : 'fixtures' }},
          {{ groupCount }} {{ groupCount === 1 ? 'island' : 'islands' }},
          {{ islandCount }} {{ islandCount === 1 ? 'square' : 'squares' }}
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

        <p class="layout_hint">
          The fixture definitions are written alongside the layout. MadMapper
          resolves a layout's fixtures by name, so import the definitions first.
          {{ definitionCount }}
          {{ definitionCount === 1 ? 'definition' : 'definitions' }} in this export.
        </p>
      </template>
    </uk-flex>
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import {
  buildMadMapperLayout,
  PROJECTION_LABELS,
  PROJECTIONS,
  PROTOCOL_LABELS,
  PROTOCOLS,
  SQUARES,
  edgeOnFixtures,
  isCameraView,
  universeOffset,
} from '@/models/DMX/generic/madmapper_layout';
import { buildMadMapperLibrary, showDefinitions } from '@/models/DMX/generic/madmapper';
import { SCENE_ITEM_KINDS, kindOf } from '@/models/DMX/scene_item';
import { labelOf } from '@/models/DMX/item_naming';
import { exportPatchSheet, itemsScope } from '@/models/DMX/patch_sheet';
import EventBus from '@/plugins/eventbus';
import PatchSheetOptions from './patchsheet.options.vue';

/** What gets a square of its own, in the order the choice lists them. */
const SQUARE_CHOICES = [
  { id: SQUARES.MAPPING, label: 'One per mapping' },
  { id: SQUARES.GROUP, label: 'One per group or structure' },
];

/** What the items can be exported as. */
const APPLICATIONS = ['MadMapper layout', 'Patch sheet (PDF)'];
const SHEET_INDEX = 1;

/** Where the last choice of target is kept, on this machine only. */
const TARGET_KEY = 'beam.exportTarget';

/**
 * @returns {Number} the target chosen last time
 */
function rememberedTarget() {
  try {
    const index = Number(window.localStorage.getItem(TARGET_KEY));
    return index >= 0 && index < APPLICATIONS.length ? index : 0;
  } catch (err) {
    return 0;
  }
}

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
  [PROJECTIONS.LINE]:
    'Every fixture in a row, one slot each, in the order they sit in their list. The shape is thrown away, so a circle takes a chase from one sweep however it is tilted.',
};

/** What each wire does to the universe numbers in the file, in one line. */
const PROTOCOL_HINTS = {
  [PROTOCOLS.ARTNET]:
    'Art-Net counts universes from zero, as Beam does, so the fixtures arrive on the universes the patch bay shows.',
  [PROTOCOLS.SACN]:
    'sACN counts universes from one, so every fixture is written a universe higher than the patch bay shows and lands where the patch bay says. Set this to whatever MadMapper is sending, not to what Beam is receiving.',
};

export default {
  name: 'UkPopupExport',
  components: { PatchSheetOptions },
  mixins: [PopupMixin],
  props: {
    /**
     * The scene items to export: the selection, or every group, structure and
     * fixture when nothing is selected. Follows the selection while open.
     * Fixtures go as themselves, structures and groups with their members.
     * Hidden ones are included -- what is exported is what was chosen.
     */
    items: {
      type: Array,
      default: () => [],
    },
    /** Whether nothing is selected, so the patch sheet prints the whole scene. */
    wholeScene: {
      type: Boolean,
      default: false,
    },
  },
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  data() {
    return {
      headerData: { title: 'Export', icon: 'export' },
      applicationIndex: rememberedTarget(),
      /** The patch sheet's choices, from its options. */
      sheetOptions: null,
      sheetAnything: false,
      applicationNames: APPLICATIONS,
      // Looked up rather than written as a number, so reordering the list
      // cannot quietly change which one a fresh export starts on.
      projectionIndex: Math.max(0, PROJECTION_LABELS.findIndex((p) => p.id === PROJECTIONS.TOP)),
      usePerspective: false,
      /** Eye distance from the rig's centre, in radii. */
      eyeDistance: 1.3,
      projectionNames: PROJECTION_LABELS.map((p) => p.label),
      // Art-Net by default. Not
      // remembered between sessions: it belongs to the MadMapper project being
      // imported into rather than to the show, and a rig only has one answer.
      protocolIndex: 0,
      protocolNames: PROTOCOL_LABELS.map((p) => p.label),
      squaresIndex: 0,
      squareNames: SQUARE_CHOICES.map((c) => c.label),
    };
  },
  computed: {
    sheet() {
      return this.applicationIndex === SHEET_INDEX;
    },
    /** What the patch sheet covers: null for the whole scene. */
    sheetScope() {
      return this.wholeScene ? null : itemsScope(this.items);
    },
    projection() {
      return (PROJECTION_LABELS[this.projectionIndex] || PROJECTION_LABELS[0]).id;
    },
    squares() {
      return (SQUARE_CHOICES[this.squaresIndex] || SQUARE_CHOICES[0]).id;
    },
    squaresHint() {
      return this.squares === SQUARES.MAPPING
        ? 'Everything using a mapping shares its square, at its place in the room.'
        : 'Each group or structure is fitted to a square of its own, per mapping.';
    },
    hint() {
      return HINTS[this.projection] || '';
    },
    protocol() {
      return (PROTOCOL_LABELS[this.protocolIndex] || PROTOCOL_LABELS[0]).id;
    },
    protocolHint() {
      const hint = PROTOCOL_HINTS[this.protocol] || '';
      const offset = universeOffset(this.protocol);
      // The rule stated as an example as well as in words. The number the user
      // is about to compare against MadMapper's own patch readout is the one
      // thing that settles whether this is set right.
      return `${hint} Beam universe 0 is written as ${offset}.`;
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
     * The patched fixtures in the selection -- the only ones either file can
     * describe -- counting those inside a selected structure or group.
     *
     * @type {Array}
     */
    exportable() {
      const fixtures = new Set();
      this.items.forEach((item) => {
        const kind = kindOf(item);
        if (kind === SCENE_ITEM_KINDS.FIXTURE) fixtures.add(item);
        if (kind === SCENE_ITEM_KINDS.STRUCTURE || kind === SCENE_ITEM_KINDS.GROUP) {
          (item.members || [])
            .filter((member) => kindOf(member) === SCENE_ITEM_KINDS.FIXTURE)
            .forEach((member) => fixtures.add(member));
        }
      });
      return [...fixtures].filter((f) => f.channels && f.channels.length);
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
     * How many 1024 squares the canvas will carry: one per group per mapping,
     * plus one for anything belonging to no group.
     *
     * @type {Number}
     */
    islandCount() {
      const groups = this.mappable
        .filter((g) => (g.members || []).some((m) => m.channels && m.channels.length));
      const grouped = new Set();
      const mappings = new Set();
      let count = 0;
      groups.forEach((g) => {
        (g.members || []).forEach((m) => grouped.add(m.id));
        const own = (g.mappings || []).length ? g.mappings : [this.projection];
        own.forEach((m) => mappings.add(m));
        count += own.length;
      });
      const loose = this.exportable.some((f) => !grouped.has(f.id));
      if (this.squares === SQUARES.MAPPING) {
        if (loose) mappings.add(this.projection);
        return mappings.size;
      }
      return count + (loose ? 1 : 0);
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
      return this.mappable.filter((g) => (g.members || []).length).length;
    },
    /**
     * The selected items that hold members and name their own mappings:
     * groups and structures alike.
     *
     * @type {Array}
     */
    mappable() {
      return this.items.filter((item) => kindOf(item) === SCENE_ITEM_KINDS.STRUCTURE
        || kindOf(item) === SCENE_ITEM_KINDS.GROUP);
    },
  },
  watch: {
    applicationIndex(index) {
      try {
        window.localStorage.setItem(TARGET_KEY, String(index));
      } catch (err) {
        // Not remembered.
      }
    },
  },
  methods: {
    sheetChange({ options, anything }) {
      this.sheetOptions = options;
      this.sheetAnything = anything;
    },
    /**
     * Writes the chosen export.
     *
     * @public
     */
    submit() {
      if (this.sheet) this.exportSheet();
      else this.exportLayout();
    },
    /**
     * Writes the patch sheet as a PDF.
     *
     * @public
     * @async
     */
    async exportSheet() {
      if (!this.sheetAnything) return;
      if (this.$refs.sheetOptions) this.$refs.sheetOptions.remember();
      const options = { ...this.sheetOptions };
      const scope = this.sheetScope;
      this.close();
      try {
        await exportPatchSheet(this.$show, options, scope);
      } catch (err) {
        EventBus.emit('app_error', new Error(`Could not export the patch sheet: ${err.message}`));
      }
    },
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
        // Structures answer the same three questions a group does -- members,
        // name, and which mappings it wants -- so the layout takes both.
        groups: this.mappable,
        projection: this.projection,
        definitionName: nameOf,
        perspective: this.perspective,
        protocol: this.protocol,
        squares: this.squares,
      });
      if (!svg) return;
      // Named for the one item when one is exported -- a single truss or
      // screen is a file of its own, and the show's name would not say which.
      // Its full name, instance included, as every export uses it. Several
      // items take the show's: `documentTitle`, not `name`, because the
      // project's name is its folder's and nothing updates `name` when a
      // project is named, so it keeps saying whatever the show was created as.
      const named = this.items.length === 1
        ? labelOf(this.items[0])
        : this.$show.documentTitle;
      const show = (named || 'layout').replace(/[<>:"/\\|?*]/g, ' ').trim() || 'layout';
      // One dialog, for the layout. The definitions go beside it under the
      // same name without being asked about: they are not a separate document
      // the user might want somewhere else, they are the half of this export
      // that names what the other half refers to. Import order still matters
      // in MadMapper -- definitions before layout -- but that is a matter for
      // importing, not for saving.
      const library = buildMadMapperLibrary(definitions);

      await window.fileExport.save({
        contents: svg,
        // No projection in the name: a group names its own mapping, so one
        // layout can carry several and claiming one of them would be a lie.
        defaultName: `${show}.svg`,
        startIn: 'madmapperFixtures',
        folderKey: `madmapper-layout|${this.$show.documentPath || ''}`,
        title: 'Export layout for MadMapper',
        filters: [{ name: 'SVG fixture layout', extensions: ['svg'] }],
        companion: library ? { contents: library, extension: 'mmfl' } : null,
        // Asked every time, with no remembered path: each export is a
        // selection, and writing one silently over the file the last one went
        // to would replace one part of the rig with another.
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
