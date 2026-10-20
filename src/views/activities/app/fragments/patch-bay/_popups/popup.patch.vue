<template>
  <uk-popup
    v-model="state"
    :valid="submittable"
    :header="headerData"
    :validate-txt="okText"
    @submit="submit"
    @input="update()"
  >
    <uk-flex class="patch_popup">
      <uk-flex
        col
        class="fixture_list_column"
      >
        <uk-flex class="kind_tabs">
          <uk-button
            v-for="kind in kinds"
            :key="kind.id"
            square
            :label="kind.label"
            :value="false"
            toggleable
            :model-value="activeKind === kind.id"
            color="var(--accent-blue)"
            @click="selectKind(kind.id)"
          />
        </uk-flex>
        <!-- Objects get a grid of square tiles: a name says very little about
             a shape. Every other kind keeps the list. -->
        <object-browser
          v-if="activeKind === 'objects'"
          class="fixture_list"
          :models="objects"
          :selected-key="selectedObject ? selectedObject.key : null"
          @select="selectObjectModel"
          @confirm="confirmObjectModel"
        />
        <uk-list
          v-else
          v-model:search="search"
          class="fixture_list"
          :items="listItems"
          :selected-id="activeKind === 'fixtures' ? selectedRowId : undefined"
          filterable
          open-folders
          @select="selectItem"
        >
          <template #filters>
            <!-- Keyed by state: the button keeps its own toggle, and three
                 states ask more of it than on and off. -->
            <uk-button
              v-if="activeKind === 'fixtures'"
              :key="`bad-${badFilter}`"
              :icon="badFilter === 'not' ? 'thumbs_down_off' : 'thumbs_down'"
              icon-only
              square
              toggleable
              :model-value="badFilter !== 'all'"
              color="var(--accent-orange)"
              :label="filterLabel('bad', badFilter)"
              @click="cycleFilter('badFilter')"
            />
            <uk-button
              v-if="activeKind === 'fixtures'"
              :key="`fav-${favouriteFilter}`"
              :icon="favouriteFilter === 'not' ? 'heart_off' : 'heart'"
              icon-only
              square
              toggleable
              :model-value="favouriteFilter !== 'all'"
              color="var(--accent-pink)"
              :label="filterLabel('favourite', favouriteFilter)"
              @click="cycleFilter('favouriteFilter')"
            />
            <filter-menu
              v-if="activeKind === 'fixtures'"
              v-model="facetFilter"
              :groups="facetGroups"
              @update:model-value="items = buildItems('fixtures')"
            />
          </template>
        </uk-list>
        <h4
          v-if="activeKind !== 'objects' && !items.length"
          class="kind_empty"
        >
          {{ emptyMessage }}
        </h4>
        <share-account
          v-if="activeKind === 'fixtures' && hasShare"
          ref="shareAccount"
          :share="shareInfo"
          :searching="searching"
          :busy="loading"
          @log-in="shareLogIn"
          @log-out="shareLogOut"
          @refresh="loadShare(true)"
        />
        <uk-flex
          v-if="activeKind !== 'structures'"
          :gap="8"
          class="fixture_list_actions"
        >
          <!-- Structures need no action here: they are made by saving a group,
               not created in this dialog. -->
          <uk-button
            v-if="activeKind === 'fixtures'"
            icon="new"
            label="create generic"
            @click="createPopupState = true"
          />
          <uk-button
            v-if="activeKind === 'fixtures'"
            icon="export"
            :label="madMapperLabel"
            :disabled="!exportableToMadMapper"
            title="Write this fixture as a MadMapper .mmfl definition, in the selected mode"
            @click="exportToMadMapper"
          />
          <uk-button
            v-if="activeKind === 'objects'"
            icon="new"
            label="create object"
            title="Build a simple shape and store it in the object library"
            @click="createObjectPopupState = true"
          />
          <uk-button
            v-if="activeKind === 'objects'"
            icon="export"
            label="import object"
            title="Copy a GLB, OBJ, FBX or STL model into the object library"
            @click="importObject"
          />
        </uk-flex>
      </uk-flex>
      <uk-flex
        col
        class="patch_form"
      >
        <div style="padding: 10px">
          <share-panel
            v-if="sharePanel"
            :mode="sharePanel"
            :share="shareInfo"
            :fixture="sharePanel === 'library' ? newerOnShare(selectedItem) : fixture.share"
            :entry="sharePanel === 'library' ? selectedItem : null"
            :bad="selectedBad"
            :favourite="selectedFavourite"
            :busy="loading"
            @update="updateFromShare"
            @mark-bad="markBad"
            @favourite="markFavourite"
            @remove="removeFromLibrary"
          />
          <uk-flex
            :gap="8"
            class="patch_form_section"
          >
            <uk-txt-input
              v-model="fixture.name"
              :disabled="!formEnabled"
              style="flex: 1"
              label="Name"
            />
            <uk-num-input
              v-model="amount"
              :disabled="!formEnabled"
              class="field"
              label="Amount"
              :min="1"
              :max="512"
              @input="autoPatch"
            />
          </uk-flex>
          <!--
            Addressing belongs to fixtures alone. A truss has no channels, and
            a structure patches its members as it creates them, so a start
            address here would only carry over whatever conflicts existed
            wherever it was saved.
          -->
          <uk-flex
            v-if="addressable"
            :gap="8"
            class="patch_form_section"
          >
            <uk-select-input
              v-model="fixture.mode"
              :disabled="!fixture.loaded || loading"
              style="flex: 1"
              label="Fixture mode"
              :options="fixture.modeNames"
            />
            <uk-num-input
              v-model="universe"
              :disabled="!fixture.loaded || loading"
              class="field"
              label="Universe"
              :min="0"
              :max="32767"
              @input="checkPatch"
            />
            <uk-num-input
              v-model="channel"
              :disabled="!fixture.loaded || loading"
              class="field"
              label="Channel"
              :min="1"
              :max="512"
              @input="checkPatch"
            />
            <uk-checkbox
              v-show="canSpan"
              v-model="fixture.universeAligned"
              label="Prevent cross universe pixels"
              style="align-self: center"
              @input="checkPatch"
            />
            <uk-num-input
              v-model="chStop"
              disabled
              class="field"
              label="Stop"
            />
          </uk-flex>
          <uk-flex
            :gap="8"
            class="patch_form_section"
          >
            <uk-txt-input
              v-model="fixture.category"
              readonly
              :disabled="!fixture.loaded || loading"
              class="field"
              style="flex: 1"
              label="Type"
            />
          </uk-flex>
          <uk-flex
            :gap="8"
            class="patch_form_section"
          >
            <div style="margin-right: 16px">
              <uk-flex
                :gap="8"
                class="patch_form_subsection"
              >
                <uk-num-input
                  v-model="fixture.position.x"
                  color="var(--axis-x-field)"
                  label="Pos X"
                  :min="-1000"
                  :max="1000"
                  :disabled="!formEnabled"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.position.y"
                  color="var(--axis-y-field)"
                  label="Pos Y"
                  :min="-1000"
                  :max="1000"
                  :disabled="!formEnabled"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.position.z"
                  color="var(--axis-z-field)"
                  label="Pos Z"
                  :min="-1000"
                  :max="1000"
                  :disabled="!formEnabled"
                  class="field"
                />
              </uk-flex>
            </div>
            <div>
              <uk-flex
                :gap="8"
                class="patch_form_subsection"
              >
                <uk-num-input
                  v-model="positionOffsets.x"
                  color="var(--axis-x-field)"
                  label="Offset X"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="positionOffsets.y"
                  color="var(--axis-y-field)"
                  label="Offset Y"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="positionOffsets.z"
                  color="var(--axis-z-field)"
                  label="Offset Z"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
              </uk-flex>
            </div>
          </uk-flex>
          <uk-flex
            :gap="8"
            class="patch_form_section"
          >
            <div style="margin-right: 16px">
              <uk-flex
                :gap="8"
                class="patch_form_subsection"
              >
                <uk-num-input
                  v-model="fixture.rotation.x"
                  color="var(--axis-x-field)"
                  label="°Rot X"
                  :max="360"
                  :disabled="!formEnabled"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.rotation.y"
                  color="var(--axis-y-field)"
                  label="°Rot Y"
                  :max="360"
                  :disabled="!formEnabled"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.rotation.z"
                  color="var(--axis-z-field)"
                  label="°Rot Z"
                  :max="360"
                  :disabled="!formEnabled"
                  class="field"
                />
              </uk-flex>
            </div>
            <div>
              <uk-flex
                :gap="8"
                class="patch_form_subsection"
              >
                <uk-num-input
                  v-model="rotationOffsets.x"
                  color="var(--axis-x-field)"
                  label="°Offset X"
                  :max="360"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="rotationOffsets.y"
                  color="var(--axis-y-field)"
                  label="°Offset Y"
                  :max="360"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="rotationOffsets.z"
                  color="var(--axis-z-field)"
                  label="°Offset Z"
                  :max="360"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
              </uk-flex>
            </div>
          </uk-flex>
          <uk-spacer />
          <p
            v-show="patchError"
            class="patch_error"
          >
            Patch error: those channels are already taken or out of range
          </p>
        </div>
        <uk-spacer />
      </uk-flex>
    </uk-flex>
    <create-fixture-popup
      v-model="createPopupState"
      @created="handleProfileCreated"
    />
    <create-object-popup
      v-model="createObjectPopupState"
      :existing="objects"
      @created="handleObjectCreated"
    />
    <import-object-popup
      v-model="importObjectPopupState"
      :pending="pendingImport"
      @imported="handleObjectImported"
    />
  </uk-popup>
</template>

<script>
import { markRaw } from 'vue';
import PopupMixin from '@/views/mixins/popup.mixin';
import fetchJson from '@/plugins/fetch_json';
import { DMX_UNIVERSE_LENGTH, channelAddress } from '@/models/DMX/patch.model';
import { buildMadMapperFixture } from '@/models/DMX/generic/madmapper';
import Fixture from '@/models/DMX/fixture.model';
import { normaliseMatrixProfile } from '@/models/DMX/ofl_matrix';
import importGdtfFiles from '@/plugins/gdtf_import';
import confirm from '@/plugins/confirm';
import { kindOf, categoryIcon, fixtureOrigin } from '@/models/DMX/generic/fixture_kind';
import { searchWords } from '@/plugins/word_search';
import {
  shareFixtures, searchFixtures, shareFixtureName, uploaderText, modesText,
} from '@/models/DMX/gdtf/share_list';
import CreateFixturePopup from './popup.create.fixture.vue';
import CreateObjectPopup from './popup.create.object.vue';
import ImportObjectPopup from './popup.import.object.vue';
import ObjectBrowser from './object.browser.vue';
import SharePanel from './share.panel.vue';
import ShareAccount from './share.account.vue';
import FilterMenu from './filter.menu.vue';
import { generateMissing } from '@/plugins/visualizer/thumbnailer';

/** How long the export button confirms for, in ms. */
const EXPORT_FEEDBACK_MS = 1500;

const NO_FIXTURE_STR = 'No fixture model selected';
const DEFAULT_FIXTURE_AMOUNT = 1;
const DEFAULT_FIXTURE_DATA = {
  universeAligned: false,
  name: NO_FIXTURE_STR,
  modeNames: [NO_FIXTURE_STR],
  category: NO_FIXTURE_STR,
  modes: [{}],
  address: 0,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  mode: 0,
  loaded: false,
};

/** How many GDTF Share matches the list shows; a longer search narrows the rest. */
const SHARE_SHOWN = 50;
/** Age at which the open popup asks for the list again; main refetches it at the same age. */
const SHARE_LIST_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** The funnel's types, by the icon that stands for each, in menu order. */
const TYPE_LABELS = {
  movinghead: 'Moving head',
  static: 'Static',
  grid: 'Matrix',
  ledbar: 'LED bar',
  laser: 'Laser',
  strobe: 'Strobe',
  projector: 'Projector or display',
  lightbulb: 'Other',
  undef: 'Not drawn',
};

/** The funnel's origins, in menu order. */
const ORIGIN_LABELS = { GDTF: 'GDTF', OFL: 'OFL', Generic: 'Generic' };

/**
 * Whether a value passes one funnel group: anything while nothing is ticked.
 *
 * @param {Array} [ticked]
 * @param {String} value
 * @returns {Boolean}
 */
const inFacet = (ticked, value) => !ticked || !ticked.length || ticked.includes(value);

/** A mark filter's next state: every fixture, only the marked, none of them. */
const NEXT_FILTER = { all: 'only', only: 'not', not: 'all' };

/** What each mark filter lists, as its button's tooltip says it. */
const FILTER_LABELS = {
  bad: {
    all: 'Listing fixtures marked bad and not: click for only those marked bad',
    only: 'Listing only fixtures marked bad: click to hide them instead',
    not: 'Hiding fixtures marked bad: click to list them too',
  },
  favourite: {
    all: 'Listing favourites and not: click for favourites only',
    only: 'Listing favourites only: click to hide them instead',
    not: 'Hiding favourites: click to list them too',
  },
};

/**
 * Whether a filter lets something through.
 *
 * @param {String} filter 'all', 'only' or 'not'
 * @param {Boolean} marked
 * @returns {Boolean}
 */
const passes = (filter, marked) => filter === 'all' || (filter === 'only') === marked;

/** What the root objects are gathered under once folders exist. */
const UNSORTED_FOLDER = 'Unsorted';

export default {
  name: 'UkPopupPatch',
  components: {
    CreateFixturePopup,
    CreateObjectPopup,
    ImportObjectPopup,
    ObjectBrowser,
    SharePanel,
    ShareAccount,
    FilterMenu,
  },
  mixins: [PopupMixin],
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Absolute address the popup opens on, when patching into a known gap.
     */
    startAddress: {
      type: Number,
      default: null,
    },
    /**
     * A library entry to open on, selected and loaded: `{ kind, key, name,
     * mode }`, `kind` fixtures (the default), objects or structures. A
     * fixture's key is its profile key, an object's its library key, a
     * structure's its name.
     */
    reveal: {
      type: Object,
      default: null,
    },
  },
  emits: ['placed'],
  data() {
    return {
      headerData: { title: 'Add to scene' },
      createPopupState: false,
      createObjectPopupState: false,
      importObjectPopupState: false,
      /** The model being imported: `{ id, entry, skipped }` while its dialog is open. */
      pendingImport: null,
      /** Guards the preview render, so opening the tab twice does not run it twice. */
      thumbnailing: false,
      /**
       * What kind of thing is being added. The list cannot nest three deep --
       * fixtures already spend their one level on manufacturers -- so the
       * kinds are tabs rather than folders above them.
       */
      activeKind: 'fixtures',
      /** Path most recently exported to, shown briefly on the button. */
      exported: false,
      /** The list for whichever kind is showing. */
      items: [],
      selectedStructure: null,
      /**
       * Models found in the library, as the object tab lists them. Fetched
       * when the dialog opens rather than watched: the folder is the
       * catalogue, and nothing here can change it.
       */
      objects: [],
      selectedObject: null,
      kinds: [
        { id: 'fixtures', label: 'fixtures' },
        { id: 'objects', label: 'objects' },
        { id: 'structures', label: 'structures' },
      ],
      fixtures: [],
      fixture: JSON.parse(JSON.stringify(DEFAULT_FIXTURE_DATA)),
      amount: DEFAULT_FIXTURE_AMOUNT,
      positionOffsets: { x: 0, y: 0, z: 0 },
      rotationOffsets: { x: 0, y: 0, z: 0 },
      chStop: 0,
      /**
       * Absolute start address of the run being patched (0-based).
       */
      patchAddress: 0,
      patchError: false,
      loading: false,
      /** The list's search box, which the GDTF Share group follows. */
      search: '',
      /** The fixture list row picked, and its id, which the list shows selected. */
      selectedItem: null,
      selectedRowId: null,
      /**
       * GDTF Share: whether an account can be stored and whose is, the
       * revision list and when it was fetched, which revision of each fixture
       * type was imported from it, and what last went wrong. Kept while the
       * dialog is closed: the list is 13,000 revisions and changes slowly.
       */
      share: {
        available: true,
        user: null,
        list: markRaw([]),
        fetched: null,
        imported: {},
        error: '',
      },
      /** The library's GDTF fixtures, as the Share list is matched against. */
      libraryGdtf: [],
      /**
       * GDTF files and Share revisions marked bad, and fixtures and Share
       * revisions marked favourite: `{ files, revisions, favourite }`.
       */
      marks: { files: {}, revisions: {}, favourite: { files: {}, revisions: {} } },
      /**
       * Which fixtures are listed by their bad mark, and by their favourite
       * mark: 'all', 'only' the marked or 'not' the marked. Kept while the
       * dialog is closed.
       */
      badFilter: 'all',
      favouriteFilter: 'all',
      /**
       * The funnel's ticked options: `{ type: [...], origin: [...] }`, a
       * fixture's type being its icon. Kept while the dialog is closed.
       */
      facetFilter: {},
      /** How many library fixtures have each type and origin, for the funnel. */
      facetCounts: { type: {}, origin: {} },
    };
  },
  computed: {
    /**
     * Whether something is selected that the common fields apply to. The
     * fixture-only fields have their own guard; these are name, amount,
     * position and rotation, which every kind of thing needs.
     *
     * @type {Boolean}
     */
    okText() {
      return this.activeKind === 'fixtures' && this.fixture.share ? 'download and add' : 'ok';
    },
    /** Every fixture on the Share, marked against the library. */
    shareAll() {
      return shareFixtures(this.share.list, this.libraryGdtf, this.share.imported);
    },
    /** The Share fixtures the search finds that the library does not have. */
    shareMatches() {
      if (!searchWords(this.search).length) return [];
      return searchFixtures(this.shareAll, this.search)
        .filter((f) => !f.inLibrary && inFacet(this.facetFilter.origin, 'GDTF')
          && this.passesFilters(
            this.marks.revisions[f.latest.rid],
            this.marks.favourite.revisions[f.latest.rid],
          ));
    },
    /** The newer Share revision of each library file that has one, by key. */
    newerByKey() {
      const newer = new Map();
      this.shareAll.forEach((f) => f.older.forEach((key) => newer.set(key, f)));
      return newer;
    },
    /** Whether the row picked, from the library or the Share, is marked bad. */
    selectedBad() {
      if (this.fixture.share) return !!this.marks.revisions[this.fixture.share.latest.rid];
      const item = this.selectedItem;
      return !!(item && item.fixture && this.marks.files[this.rowKey(item)]);
    },
    /** The funnel's groups: the types and origins the library has. */
    facetGroups() {
      const options = (group, labels) => Object.keys(labels)
        .filter((id) => this.facetCounts[group][id])
        .map((id) => ({
          id,
          label: labels[id],
          icon: group === 'type' ? id : null,
          count: this.facetCounts[group][id],
        }));
      return [
        { id: 'type', title: 'Type', options: options('type', TYPE_LABELS) },
        { id: 'origin', title: 'Origin', options: options('origin', ORIGIN_LABELS) },
      ];
    },
    /** How many fixtures in the show use the library fixture picked. */
    selectedInUse() {
      const item = this.selectedItem;
      if (!item || !item.fixture || this.fixture.share) return 0;
      const key = this.rowKey(item);
      return this.$show.fixturePool.fixtures.filter((f) => f.profileKey === key).length;
    },
    /** Whether the row picked, from the library or the Share, is a favourite. */
    selectedFavourite() {
      const { favourite } = this.marks;
      if (this.fixture.share) return !!favourite.revisions[this.fixture.share.latest.rid];
      const item = this.selectedItem;
      return !!(item && item.fixture && favourite.files[this.rowKey(item)]);
    },
    /** Whether this build talks to GDTF Share: the preload exposes it. */
    hasShare() {
      return !!window.gdtfShare;
    },
    /** Whether the search has words, which is when the Share is searched too. */
    searching() {
      return searchWords(this.search).length > 0;
    },
    shareInfo() {
      return {
        available: this.share.available,
        user: this.share.user,
        fetched: this.share.fetched,
        count: this.shareAll.length,
        error: this.share.error,
      };
    },
    /**
     * The GDTF Share group under the library's matches, while there is a
     * search: the login while no account is stored, else what the Share has
     * that the library does not.
     */
    shareGroup() {
      if (this.activeKind !== 'fixtures' || !window.gdtfShare) return null;
      if (!searchWords(this.search).length) return null;
      const note = (id, name, icon) => ({
        id: `share/${id}`, name, icon, shareAccount: true,
      });
      let children;
      if (!this.share.user) {
        children = [note('login', 'Log in to search GDTF Share', 'key')];
      } else if (!this.share.fetched) {
        children = [note('nolist', this.share.error ? 'No list: see the error' : 'Fetching the list', 'undef')];
      } else {
        children = this.shareMatches.slice(0, SHARE_SHOWN).map((f) => {
          const bad = !!this.marks.revisions[f.latest.rid];
          const favourite = !!this.marks.favourite.revisions[f.latest.rid];
          const more = [
            bad ? 'marked bad' : null,
            favourite ? 'favourite' : null,
            uploaderText(f),
            modesText(f.latest),
          ].filter(Boolean).join(' · ');
          return {
            id: `share/${f.key}`,
            name: `${f.manufacturer} ${shareFixtureName(f)}`,
            icon: bad ? 'disabled' : 'fixture',
            more,
            share: f,
          };
        });
        const rest = this.shareMatches.length - children.length;
        if (rest > 0) children.push(note('more', `${rest} more: narrow the search`, 'help'));
      }
      return {
        id: 'share',
        name: 'On GDTF Share',
        icon: 'library',
        more: this.share.fetched ? `${this.shareMatches.length}` : '',
        // Matched by the Share's own search above, and holding the login.
        unfiltered: true,
        shareAccount: true,
        unfold: children,
      };
    },
    listItems() {
      return this.shareGroup ? [...this.items, this.shareGroup] : this.items;
    },
    /** What the GDTF Share panel shows for the row picked, or null for none. */
    sharePanel() {
      if (this.activeKind !== 'fixtures') return null;
      if (this.fixture.share) return 'fixture';
      const item = this.selectedItem;
      if (item && item.shareAccount) return null;
      if (item && item.fixture && item.manufacturer) return 'library';
      return null;
    },
    formEnabled() {
      return (this.fixture.loaded || !!this.selectedStructure || !!this.selectedObject)
        && !this.loading;
    },
    /**
     * Whether OK can do anything with what is selected.
     *
     * @type {Boolean}
     */
    submittable() {
      if (this.loading) return false;
      if (this.activeKind === 'structures') return !!this.selectedStructure;
      if (this.activeKind === 'objects') return !!this.selectedObject;
      return this.fixture.loaded && !this.patchError;
    },
    /**
     * Whether the selected thing occupies DMX channels of its own.
     *
     * @type {Boolean}
     */
    addressable() {
      if (this.activeKind !== 'fixtures') return false;
      // A loaded profile may declare no channels at all -- most projectors have
      // no DMX socket -- and something that occupies nothing is not an
      // addressing problem. Asked only once loaded, because the default fixture
      // carries an empty mode rather than none, and hiding the fields before a
      // profile is picked would be a different change.
      if (this.fixture.loaded && !this.modeChannelCount) return false;
      return true;
    },
    /**
     * How many channels the selected mode occupies.
     *
     * Nought before a profile is loaded, and nought for a model that declares
     * no channels -- which is a real answer, not a missing one.
     *
     * @type {Number}
     */
    modeChannelCount() {
      if (!this.fixture || !this.fixture.loaded) return 0;
      const mode = this.fixture.modes[this.fixture.mode];
      return mode && mode.channels ? mode.channels.length : 0;
    },
    /**
     * What to call this fixture in MadMapper.
     *
     * The profile's own name, not `model`: for a library fixture that is the
     * file it was loaded from, so exporting one would produce a fixture called
     * "mac-aura.json". Generated profiles name themselves after the model, so
     * both come out the same there.
     *
     * @type {String}
     */
    madMapperGroup() {
      return this.$show.manufacturerName(this.fixture.manufacturer);
    },
    madMapperProduct() {
      return (this.fixture.OFLData || {}).name || this.fixture.model || '';
    },
    /**
     * Pixel size to lay the selected fixture out with.
     *
     * Mirrors `Fixture.alignmentPixelSize`, which cannot be used directly:
     * nothing here is a Fixture yet, only the form that will become one.
     *
     * @type {Number}
     */
    alignmentPixelSize() {
      if (!this.fixture.loaded || !this.fixture.universeAligned) return 1;
      const { components } = (this.fixture.OFLData || {}).beam || {};
      if (components && components.length) return components.length;
      const mode = this.fixture.modes[this.fixture.mode];
      return (mode && mode.channels && mode.channels.length) || 1;
    },
    /**
     * The selected fixture as a MadMapper document, when it can be one.
     *
     * A generated bar exports as a pixel grid and a library profile as a
     * Custom channel list, so nearly everything is expressible; what is not is
     * a profile whose mode embeds a pixel matrix, and that comes back null
     * rather than as a file with its channels quietly misaligned.
     *
     * @type {String|null}
     */
    madMapperDocument() {
      if (!this.fixture.loaded || !this.fixture.OFLData) return null;
      return buildMadMapperFixture(this.fixture.OFLData, {
        group: this.madMapperGroup,
        product: this.madMapperProduct,
        mode: this.fixture.modes[this.fixture.mode],
        avoidCrossUniversePixels: Fixture.profileKeepsPixelsWhole(this.fixture.OFLData),
      });
    },
    exportableToMadMapper() {
      return !!this.madMapperDocument;
    },
    madMapperLabel() {
      return this.exported ? 'exported' : 'to MadMapper';
    },
    emptyMessage() {
      if (this.activeKind === 'objects') return 'No objects yet';
      if (this.activeKind === 'structures') return 'No saved structures';
      return 'Nothing to display';
    },
    count() {
      if (this.fixture.modes[this.fixture.mode]) {
        return this.fixture.modes[this.fixture.mode].length - 1;
      }
      return 0;
    },
    /**
     * 1-based DMX address shown to the user, mapped to the 0-based internal chStart.
     */
    /**
     * The skip changes nothing for a run too short to reach a boundary.
     */
    canSpan() {
      if (!this.fixture.loaded || !this.fixture.modes[this.fixture.mode]) return false;
      const chCount = this.fixture.modes[this.fixture.mode].channels.length * this.amount;
      return (this.patchAddress % DMX_UNIVERSE_LENGTH) + chCount > DMX_UNIVERSE_LENGTH;
    },
    /**
     * Universe the run starts in. Universe and channel are edited separately,
     * the way MadMapper and consoles express an address; internally they are
     * one absolute offset, which is what lets a run cross a boundary.
     */
    universe: {
      get() {
        return Math.floor(this.patchAddress / DMX_UNIVERSE_LENGTH);
      },
      set(value) {
        const universe = Math.max(0, Number(value));
        this.patchAddress = universe * DMX_UNIVERSE_LENGTH
          + (this.patchAddress % DMX_UNIVERSE_LENGTH);
      },
    },
    /**
     * 1-based start channel within that universe.
     */
    channel: {
      get() {
        return (this.patchAddress % DMX_UNIVERSE_LENGTH) + 1;
      },
      set(value) {
        const channel = Math.max(0, Number(value) - 1);
        this.patchAddress = this.universe * DMX_UNIVERSE_LENGTH + channel;
      },
    },
  },
  watch: {
    state(state) {
      if (state) {
        this.init();
      }
    },
    // An import while the dialog is already open.
    reveal(reveal) {
      if (this.state && reveal) this.revealItem(reveal);
    },
  },
  mounted() {
    this.init();
  },
  methods: {
    /**
     * Initialise popup variables
     *
     * @public
     */
    init() {
      this.activeKind = 'fixtures';
      this.selectedStructure = null;
      this.selectedObject = null;
      this.loadObjects();
      this.items = this.buildItems(this.activeKind);
      this.fixture = JSON.parse(JSON.stringify(DEFAULT_FIXTURE_DATA));
      this.amount = DEFAULT_FIXTURE_AMOUNT;
      this.positionOffsets = { x: 0, y: 0, z: 0 };
      this.rotationOffsets = { x: 0, y: 0, z: 0 };
      this.chStop = 0;
      this.patchAddress = this.startAddress || 0;
      this.patchError = false;
      this.selectedItem = null;
      this.selectedRowId = null;
      this.search = '';
      this.libraryGdtf = this.$show.gdtfFixtures || [];
      this.loadMarks();
      this.loadShare(false);
      if (this.reveal) this.revealItem(this.reveal);
    },
    /**
     * Adds whatever is selected, in as many copies as asked for.
     *
     * @public
     * @async
     */
    async submit() {
      if (this.activeKind === 'structures') {
        await this.placeStructures();
        return;
      }
      if (this.activeKind === 'objects') {
        await this.placeObjects();
        return;
      }
      if (this.fixture.share) {
        await this.addFromShare();
        return;
      }
      this.patchFixtures();
    },
    /**
     * Places the selected model, offsetting each copy as the others do.
     *
     * @public
     * @async
     */
    async placeObjects() {
      if (!this.selectedObject) return;
      this.loading = true;
      const base = { ...this.fixture.position };
      const spin = { ...this.fixture.rotation };
      const toRad = (deg) => (deg * Math.PI) / 180;
      const placed = [];
      try {
        for (let i = 0; i < this.amount; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const object = await this.$show.placeObject(this.selectedObject, {
            position: {
              x: base.x + this.positionOffsets.x * i,
              y: base.y + this.positionOffsets.y * i,
              z: base.z + this.positionOffsets.z * i,
            },
            rotation: {
              x: toRad(spin.x + this.rotationOffsets.x * i),
              y: toRad(spin.y + this.rotationOffsets.y * i),
              z: toRad(spin.z + this.rotationOffsets.z * i),
            },
          });
          if (object) placed.push(object);
        }
      } catch (err) {
        // A model that will not load is worth saying out loud: the file is in
        // the user's own folder and they can act on it.
        // eslint-disable-next-line no-console
        console.error(`[objects] could not place ${this.selectedObject.name}: ${err.message}`);
      }
      this.loading = false;
      // What was just added is what the user is looking at, so it arrives
      // selected -- the same courtesy the structure path extends.
      if (placed.length) {
        this.$emit('placed', { kind: 'object', ids: placed.map((o) => o.id) });
      }
      this.close();
    },
    /**
     * Places the selected structure, offsetting each copy as the fixture path
     * does.
     *
     * @public
     * @async
     */
    async placeStructures() {
      this.loading = true;
      const base = { ...this.fixture.position };
      const spin = { ...this.fixture.rotation };
      const toRad = (deg) => (deg * Math.PI) / 180;
      const placed = [];
      for (let i = 0; i < this.amount; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const structure = await this.$show.placeStructure(this.selectedStructure, {
          position: {
            x: base.x + this.positionOffsets.x * i,
            y: base.y + this.positionOffsets.y * i,
            z: base.z + this.positionOffsets.z * i,
          },
          rotation: {
            x: toRad(spin.x + this.rotationOffsets.x * i),
            y: toRad(spin.y + this.rotationOffsets.y * i),
            z: toRad(spin.z + this.rotationOffsets.z * i),
          },
        });
        if (structure) placed.push(structure);
      }
      this.loading = false;
      // What was just added is what the user is looking at, so it arrives
      // selected. This is not the list picking a default -- it is the outcome
      // of an action they took.
      if (placed.length) {
        this.$emit('placed', { kind: 'structure', ids: placed.map((o) => o.id) });
      }
      // close(), not `state = false`. Setting the local copy alone leaves the
      // parent still holding true, so the next "+ New" assigns true to true,
      // the modelValue watcher never fires, and the dialog cannot be reopened
      // for the rest of the session.
      this.close();
    },
    /**
     * Patch selected fixture using provided form parameters.
     *
     * @public
     */
    // eslint-disable-next-line consistent-return
    patchFixtures() {
      if (this.fixture.loaded && !this.patchError) {
        this.loading = true;
        const fixtures = [];
        if (this.checkPatch()) {
          try {
            const position_tmp = {};
            const rotation_tmp = {};
            const chCount = this.modeChannelCount;
            // The name as typed, or the profile's when the field was cleared.
            // Each fixture is numbered under it as it joins the pool.
            const name = (this.fixture.name || '').trim() || this.fixture.OFLData.name;
            Object.assign(position_tmp, this.fixture.position);
            Object.assign(rotation_tmp, this.fixture.rotation);
            // Asked for rather than multiplied out: a fixture keeping its
            // pixels whole occupies more address space than its channel count,
            // so spacing the batch by that count alone puts every fixture past
            // the first universe boundary inside the one before it.
            const run = this.$show.patch.addressRun(
              this.patchAddress,
              chCount,
              this.amount,
              this.alignmentPixelSize,
            );
            for (let i = 0; i < this.amount; i++) {
              this.fixture.address = run[i];
              this.fixture.position = {
                x: position_tmp.x + this.positionOffsets.x * i,
                y: position_tmp.y + this.positionOffsets.y * i,
                z: position_tmp.z + this.positionOffsets.z * i,
              };
              this.fixture.rotation = {
                x: rotation_tmp.x + this.rotationOffsets.x * i,
                y: rotation_tmp.y + this.rotationOffsets.y * i,
                z: rotation_tmp.z + this.rotationOffsets.z * i,
              };
              this.fixture.name = name;
              this.fixture.instance = null;
              // A copy for each, but the GDTF fixture type is shared as it
              // is: read-only, and its lookups do not survive JSON.
              const { fixtureType } = this.fixture;
              const copy = JSON.parse(JSON.stringify({ ...this.fixture, fixtureType: null }));
              copy.fixtureType = fixtureType || null;
              const fixture = this.$show.fixturePool.addRaw(copy);
              this.$show.patchFixture(fixture);
              // Placed on the floor, not through it: a fixture whose body reaches
              // below its origin -- a display, a projector -- is lifted until it
              // rests on the floor. A height set above that stays as it is.
              const model = fixture._3DModel;
              const sunk = model ? (Number(model.floorOffset) || 0) - fixture.position.z : 0;
              if (sunk > 0) {
                fixture.position = {
                  ...fixture.position,
                  z: Math.round((fixture.position.z + sunk) * 100) / 100,
                };
              }
              // Collected rather than left empty: this list is returned, and
              // something has to name what was added.
              fixtures.push(fixture);
            }
            this.loading = false;
            if (fixtures.length) {
              this.$emit('placed', { kind: 'fixture', ids: fixtures.map((f) => f.id) });
            }
            this.close();
            return fixtures;
          } catch (err) {
            this.loading = false;
            throw err;
          }
        } else {
          this.loading = false;
          throw new Error('Those channels are already taken');
        }
      }
    },
    /**
     * Loads selected fixture configuration file
     *
     * @public
     * @async
     */
    /**
     * Icon for a list entry: its generic kind's, else its category's; an
     * unrendered one says so instead.
     *
     * @public
     * @param {Object} entry fixture list entry
     * @param {Object} [profile] its generated profile, when it has one
     * @returns {String} icon name
     */
    entryIcon(entry, profile) {
      if (!entry.supported) return 'undef';
      const kind = kindOf(profile);
      return kind ? kind.icon : categoryIcon(entry.category);
    },
    /**
     * Shows the freshly created profile, selected and ready to patch, rather
     * than leaving the user to find it in the list.
     *
     * @public
     * @async
     * @param {String} key `manufacturer/model` of the new profile
     */
    /**
     * Puts a created object in the scene.
     *
     * Nothing is written to the library. The parameters go straight into the
     * show, where the object keeps them and stays editable through its widget;
     * Save to library is a separate, deliberate act, so experiments do not
     * become permanent library entries.
     *
     * Placed where the form's position and rotation say, exactly as a library
     * object would be, and the Add dialog closes because the job is done.
     *
     * @public
     * @async
     * @param {Object} params `{ type, name, size, color }`
     */
    async handleObjectCreated({ params, amount }) {
      const base = { ...this.fixture.position };
      const spin = { ...this.fixture.rotation };
      const toRad = (deg) => (deg * Math.PI) / 180;
      const placed = [];
      // Offset copy by copy exactly as `placeObjects` and `placeStructures`
      // do, so a shape built here is spaced the same way one taken from the
      // library is -- including when the offsets are zero and they stack.
      try {
        for (let i = 0; i < Math.max(1, amount || 1); i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const object = await this.$show.createObject(params, {
            position: {
              x: base.x + this.positionOffsets.x * i,
              y: base.y + this.positionOffsets.y * i,
              z: base.z + this.positionOffsets.z * i,
            },
            rotation: {
              x: toRad(spin.x + this.rotationOffsets.x * i),
              y: toRad(spin.y + this.rotationOffsets.y * i),
              z: toRad(spin.z + this.rotationOffsets.z * i),
            },
          });
          if (object) placed.push(object);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[objects] could not create ${params.name}: ${err.message}`);
      }
      if (!placed.length) return;
      // Arrives selected, the same courtesy the structure and object paths
      // extend -- and it is what the new widget needs to edit.
      this.$emit('placed', { kind: 'object', ids: placed.map((o) => o.id) });
      this.state = false;
      this.update();
    },
    /**
     * The account and the revision list; the list again when `refresh` or
     * when the copy held is `SHARE_LIST_MAX_AGE_MS` old. The saved list is
     * shown first, so a slow Share holds up nothing.
     *
     * @public
     * @async
     * @param {Boolean} refresh fetch the list from the Share
     */
    async loadShare(refresh) {
      if (!window.gdtfShare) return;
      const status = await window.gdtfShare.status();
      this.share.available = status.available;
      this.share.user = status.user;
      if (!status.user) return;
      this.share.imported = (await window.gdtfShare.imported()) || {};
      if (!this.share.fetched) {
        const saved = await window.gdtfShare.saved();
        if (saved.ok) this.showShareList(saved);
      }
      const held = this.share.fetched && Date.now() - this.share.fetched < SHARE_LIST_MAX_AGE_MS;
      if (held && !refresh) return;
      this.loading = refresh;
      const result = await window.gdtfShare.list(refresh);
      this.loading = false;
      if (!result.ok) {
        this.share.error = result.error;
        return;
      }
      // A saved list shown because the Share could not be reached.
      this.share.error = result.error ? `Showing the saved list: ${result.error}` : '';
      if (result.fetched !== this.share.fetched) this.showShareList(result);
    },
    /** Puts a revision list from `gdtfShare` in the popup. */
    showShareList(result) {
      this.share.list = markRaw(result.list);
      this.share.fetched = result.fetched;
      // The library's rows say which of them the Share has newer.
      if (this.activeKind === 'fixtures') this.items = this.buildItems('fixtures');
    },
    async shareLogIn(user, password) {
      this.loading = true;
      this.share.error = '';
      const result = await window.gdtfShare.saveAccount(user, password);
      this.loading = false;
      if (!result.ok) {
        this.share.error = result.error;
        return;
      }
      await this.loadShare(true);
    },
    async shareLogOut() {
      await window.gdtfShare.forgetAccount();
      Object.assign(this.share, {
        user: null, list: markRaw([]), fetched: null, imported: {}, error: '',
      });
      this.items = this.buildItems('fixtures');
    },
    /**
     * The newer Share revision of a library row, or null.
     *
     * @public
     * @param {Object} item a fixture list row
     * @returns {Object|null} from `shareFixtures`
     */
    newerOnShare(item) {
      if (!item || !item.gdtf) return null;
      return this.newerByKey.get(item.fixture) || null;
    },
    /**
     * Reads the bad marks, and relists the library by them.
     *
     * @public
     * @async
     */
    async loadMarks() {
      if (!window.library || !window.library.gdtfMarks) return;
      this.marks = await window.library.gdtfMarks();
      if (this.activeKind === 'fixtures') this.items = this.buildItems('fixtures');
    },
    /**
     * A mark filter's tooltip.
     *
     * @public
     * @param {String} mark 'bad' or 'favourite'
     * @param {String} filter
     * @returns {String}
     */
    filterLabel(mark, filter) {
      return FILTER_LABELS[mark][filter];
    },
    /**
     * Steps a mark filter on: all, only the marked, not the marked.
     *
     * @public
     * @param {String} name 'badFilter' or 'favouriteFilter'
     */
    cycleFilter(name) {
      this[name] = NEXT_FILTER[this[name]];
      this.items = this.buildItems('fixtures');
    },
    /**
     * Whether something with these marks is listed under both filters.
     *
     * @public
     * @param {*} bad truthy when marked bad
     * @param {*} favourite truthy when marked favourite
     * @returns {Boolean}
     */
    passesFilters(bad, favourite) {
      return passes(this.badFilter, !!bad) && passes(this.favouriteFilter, !!favourite);
    },
    /**
     * The mark target for what is picked: a library fixture by its key, a
     * GDTF one with the Share revision it was imported as, or a Share
     * fixture's revision; null for anything else.
     *
     * @public
     * @returns {Object|null} `{ key, rid }`
     */
    markTarget() {
      if (this.fixture.share) return { rid: this.fixture.share.latest.rid };
      const item = this.selectedItem;
      if (!item || !item.fixture) return null;
      if (item.gdtf) return { key: item.fixture, rid: this.share.imported[item.fixture] };
      return { key: this.rowKey(item) };
    },
    /**
     * Relists after a mark changed, and lets go of what is picked if the
     * filters no longer list it.
     *
     * @public
     */
    relistAfterMark() {
      this.items = this.buildItems('fixtures');
      if (this.passesFilters(this.selectedBad, this.selectedFavourite)) return;
      this.selectedItem = null;
      this.selectedRowId = null;
      this.clearFixture();
    },
    /**
     * Marks what is picked favourite, or clears the mark.
     *
     * @public
     * @async
     * @param {Boolean} favourite
     */
    async markFavourite(favourite) {
      const what = this.markTarget();
      if (!what) return;
      this.marks = await window.library.setFavourite(what, favourite);
      this.relistAfterMark();
    },
    /**
     * Marks what is picked bad, or clears the mark.
     *
     * @public
     * @async
     * @param {Boolean} bad
     */
    async markBad(bad) {
      const what = this.markTarget();
      if (!what) return;
      this.marks = await window.library.setGdtfBad(what, bad);
      this.relistAfterMark();
    },
    /**
     * Removes the picked GDTF file from the library, once asked. The file is
     * kept where shows still find it, so nothing that uses it changes.
     *
     * @public
     * @async
     */
    async removeFromLibrary() {
      const item = this.selectedItem;
      if (!item || !item.gdtf) return;
      if (item.shipped) {
        this.share.error = `${item.name} ships with Beam and is not in your library to remove.`;
        return;
      }
      const used = this.selectedInUse;
      let inShow = '';
      if (used === 1) inShow = '1 fixture in this project uses it. ';
      else if (used > 1) inShow = `${used} fixtures in this project use it. `;
      const yes = await confirm({
        title: 'Remove from library',
        message: `Remove ${item.name} from your library?`,
        detail: `File: ${item.fixture.split('/').pop()}.gdtf\n${inShow}`
          + 'It is no longer offered to add; this project and saved projects that use it keep '
          + 'working. Importing the file again brings it back.',
        yes: 'Remove',
        no: 'Keep',
      });
      if (!yes) return;
      const result = await window.library.removeGdtf(item.fixture);
      if (!result.ok) {
        this.share.error = `Could not remove ${item.name}: ${result.reason}`;
        return;
      }
      await this.$show.refreshGdtfFixtures();
      this.libraryGdtf = this.$show.gdtfFixtures || [];
      this.share.imported = await window.gdtfShare.imported();
      this.marks = await window.library.gdtfMarks();
      this.selectedItem = null;
      this.selectedRowId = null;
      this.clearFixture();
      this.items = this.buildItems('fixtures');
    },
    /**
     * Fills the form from what the Share lists about a fixture, so a mode and
     * an address can be chosen before anything is downloaded. The channel
     * counts are the Share's; the file decides once it is in.
     *
     * @public
     * @param {Object} f from `shareFixtures`
     */
    selectShareFixture(f) {
      const modes = (f.latest.modes || []).map((m) => ({
        name: m.name,
        channels: new Array(Math.max(0, Number(m.dmxfootprint) || 0)).fill(''),
      }));
      Object.assign(this.fixture, {
        OFLData: null,
        fixtureType: null,
        modes: modes.length ? modes : [{}],
        modeNames: modes.length ? modes.map((m) => m.name) : ['no modes listed'],
        mode: 0,
        name: shareFixtureName(f),
        model: '',
        manufacturer: f.manufacturer,
        category: '',
        universeAligned: false,
        loaded: true,
        share: f,
      });
      this.patchError = false;
      this.autoPatch();
    },
    /** Empties the form's fixture, leaving position and the rest as typed. */
    clearFixture() {
      Object.assign(this.fixture, {
        OFLData: null,
        fixtureType: null,
        modes: [{}],
        modeNames: [NO_FIXTURE_STR],
        mode: 0,
        name: NO_FIXTURE_STR,
        category: NO_FIXTURE_STR,
        loaded: false,
        share: null,
      });
      this.patchError = false;
    },
    /**
     * Downloads a Share fixture's newest revision into the library.
     *
     * @public
     * @async
     * @param {Object} f from `shareFixtures`
     * @param {String} [conflict] 'keepBoth' to add it beside a revision in the
     *   library without asking; otherwise asked
     * @returns {Promise<Object|null>} the library entry, or null when it did
     *   not arrive
     */
    async downloadFromShare(f, conflict = null) {
      this.share.error = '';
      const r = f.latest;
      const result = await window.gdtfShare.download(r.rid, {
        manufacturer: r.manufacturer, fixture: r.fixture, revision: r.revision,
      });
      if (!result.ok) {
        this.share.error = `Could not download ${r.manufacturer} ${r.fixture}: ${result.error}`;
        return null;
      }
      const entries = await importGdtfFiles([result.path], this.$show, { conflict, reveal: false });
      const took = entries.find((e) => String(e.fixtureTypeId || '').toUpperCase() === f.uuid)
        || (entries.length === 1 ? entries[0] : null);
      if (!took) return null;
      this.share.imported = await window.gdtfShare.recordImport(took.key, r.rid);
      this.libraryGdtf = this.$show.gdtfFixtures || [];
      this.items = this.buildItems('fixtures');
      return took;
    },
    /**
     * Adds a fixture picked from the Share: downloads it, loads it as any
     * library fixture loads, keeps the mode, name and address chosen, and
     * places it.
     *
     * @public
     * @async
     */
    async addFromShare() {
      const f = this.fixture.share;
      const form = {
        name: this.fixture.name,
        named: this.fixture.name !== shareFixtureName(f),
        modeName: this.fixture.modeNames[this.fixture.mode],
        modeIndex: this.fixture.mode,
        address: this.patchAddress,
      };
      this.loading = true;
      const entry = await this.downloadFromShare(f);
      if (!entry) {
        this.loading = false;
        return;
      }
      const row = this.findGdtfRow(entry.key);
      this.selectedItem = row;
      this.selectedRowId = row ? row.id : null;
      await this.loadGdtfFixture({ fixture: entry.key, name: entry.name });
      this.loading = false;
      if (!this.fixture.loaded) {
        this.share.error = `${entry.manufacturer} ${entry.name} is in the library but cannot be read.`;
        return;
      }
      const byName = this.fixture.modeNames.indexOf(form.modeName);
      this.fixture.mode = byName >= 0 ? byName
        : Math.min(form.modeIndex, this.fixture.modeNames.length - 1);
      if (form.named) this.fixture.name = form.name;
      this.patchAddress = form.address;
      // Placed only where the file's own channel count still fits; otherwise
      // the form shows why, with the fixture now in the library.
      if (this.checkPatch()) this.patchFixtures();
    },
    /**
     * Brings the Share's newer revision of the selected library fixture in
     * beside it, so shows built on the one there keep it.
     *
     * @public
     * @async
     */
    async updateFromShare() {
      const f = this.newerOnShare(this.selectedItem);
      if (!f) return;
      this.loading = true;
      const entry = await this.downloadFromShare(f, 'keepBoth');
      this.loading = false;
      if (!entry) return;
      const row = this.findGdtfRow(entry.key);
      if (row) await this.selectItem(row);
    },
    /**
     * A GDTF fixture's row in the fixture list.
     *
     * @public
     * @param {String} key
     * @returns {Object|null}
     */
    findGdtfRow(key) {
      const rows = this.items.flatMap((folder) => folder.unfold || []);
      return rows.find((row) => row.gdtf && row.fixture === key) || null;
    },
    /**
     * Opens on a library entry: its kind's tab, searched for so it shows,
     * and selected, a fixture in the mode asked for.
     *
     * @public
     * @async
     * @param {Object} reveal `{ kind, key, name, mode }`
     */
    async revealItem({
      kind = 'fixtures', key, name, mode,
    }) {
      if (kind === 'objects') {
        if (this.activeKind !== 'objects') this.selectKind('objects');
        const model = this.objects.find((entry) => entry.key === key);
        if (model) this.selectObjectModel(model);
        return;
      }
      if (kind === 'structures') {
        if (this.activeKind !== 'structures') this.selectKind('structures');
        const row = this.items.find((entry) => entry.structure === key);
        this.search = key || '';
        if (row) await this.selectItem(row);
        return;
      }
      if (this.activeKind !== 'fixtures') this.selectKind('fixtures');
      this.libraryGdtf = this.$show.gdtfFixtures || [];
      this.items = this.buildItems('fixtures');
      const row = this.findFixtureRow(key);
      this.search = row ? row.name : (name || '');
      if (!row) return;
      await this.selectItem(row);
      const at = mode ? this.fixture.modeNames.indexOf(mode) : -1;
      if (at >= 0 && at !== this.fixture.mode) {
        this.fixture.mode = at;
        this.autoPatch();
      }
    },
    /**
     * A fixture's row in the list by its profile key: a GDTF fixture's is its
     * key, a profile's its manufacturer and file.
     *
     * @public
     * @param {String} key
     * @returns {Object|null}
     */
    findFixtureRow(key) {
      const rows = this.items.flatMap((folder) => folder.unfold || []);
      return rows.find((row) => this.rowKey(row) === key) || null;
    },
    /**
     * A fixture row's profile key: a GDTF fixture's is its key, a profile's
     * its manufacturer and file.
     *
     * @public
     * @param {Object} row
     * @returns {String}
     */
    rowKey(row) {
      return row.gdtf ? row.fixture : `${row.manufacturer.name}/${row.fixture}`;
    },
    async handleProfileCreated(key) {
      this.items = this.buildItems('fixtures');
      const [manufacturer, model] = key.split('/');
      await this.loadFixture({ manufacturer: { name: manufacturer }, fixture: model });
    },
    /**
     * Switches which kind of thing is being added.
     *
     * @public
     * @param {String} id kind id
     */
    selectKind(id) {
      this.activeKind = id;
      this.selectedStructure = null;
      this.selectedObject = null;
      this.selectedItem = null;
      this.selectedRowId = null;
      if (this.fixture.share) this.clearFixture();
      this.items = this.buildItems(id);
    },
    /**
     * Builds a fresh list for a kind.
     *
     * @public
     * @param {String} id kind id
     * @returns {Array} list entries
     */
    /**
     * Reads the models folder, and refreshes the list if it is on screen.
     *
     * Outside Electron there is no library to read, so the tab stays empty
     * rather than erroring.
     *
     * @public
     * @async
     */
    async loadObjects() {
      if (!window.library || !window.library.objects) return;
      try {
        this.objects = await window.library.objects();
      } catch (err) {
        this.objects = [];
      }
      if (this.activeKind === 'objects') this.items = this.buildItems('objects');
      await this.ensureThumbnails();
    },
    /**
     * Renders a preview for any object that has none, then re-reads the list.
     *
     * Deliberately after the catalogue is already on screen: the browser shows
     * placeholders immediately and the pictures arrive as they are drawn, which
     * is better than an empty panel while fifty models render. Each is written
     * beside its model, so this happens once in the life of a library rather
     * than once per session.
     *
     * Failures are ordinary here -- a model that will not load, a read-only
     * install -- and leave the placeholder, which is honest about it.
     *
     * @public
     * @async
     */
    async ensureThumbnails() {
      if (this.thumbnailing) return;
      this.thumbnailing = true;
      try {
        const written = await generateMissing(this.objects);
        if (written) {
          this.objects = await window.library.objects();
          if (this.activeKind === 'objects') this.items = this.buildItems('objects');
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[thumbnail] batch failed: ${err.message}`);
      }
      this.thumbnailing = false;
    },
    /**
     * One row per object, with folders as unfoldable rows above them.
     *
     * A folder in `Library/Objects` is a category, and one level of them is all
     * the catalogue offers -- which happens to be exactly what `uk-list` nests,
     * so this is the same shape the group rows already use.
     *
     * Root objects come first and unfoldered, so a library nobody has organised
     * looks exactly as it did before folders existed.
     *
     * @public
     * @returns {Array} list rows
     */
    objectRows() {
      // Last, and named for what it is: these are the objects sitting loose in
      // Library/Objects, not the contents of a folder called this.
      const row = (model) => ({
        name: model.name,
        icon: 'object',
        object: model,
        // Its size on disk says nothing useful; whether it has been through
        // import decides how it will be scaled and turned, and that is the
        // thing worth knowing before placing one.
        more: [
          model.described ? `${model.scale}x ${String(model.upAxis).toUpperCase()}-up` : 'not imported',
          // Worth saying: a shipped model cannot be edited or deleted from
          // here, and one of the same name in the user's library replaces it.
          model.shipped ? 'supplied' : null,
        ].filter(Boolean).join(' · '),
      });

      const roots = this.objects.filter((model) => !model.folder);
      const folders = new Map();
      this.objects.filter((model) => model.folder).forEach((model) => {
        if (!folders.has(model.folder)) folders.set(model.folder, []);
        folders.get(model.folder).push(model);
      });

      const folderRow = (name, models) => ({
        name,
        icon: 'folder',
        // No `object`, so selecting the folder itself places nothing -- the
        // Add button stays disabled until something inside it is chosen.
        more: `${models.length}`,
        unfold: models.map(row),
      });

      const folderRows = [...folders.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([folder, models]) => folderRow(folder, models));

      // Nothing filed yet: show the objects themselves rather than one folder
      // holding all of them, which would be a category that says nothing.
      if (!folderRows.length) return roots.map(row);

      // Otherwise the top level is folders and only folders. Six loose files
      // above four folders is more clutter than catalogue, and the loose ones
      // are the least likely to be what is being looked for -- they are the
      // ones nobody has got round to filing.
      //
      // `Unsorted` is not a directory on disk, and saying so matters: renaming
      // or moving it in Explorer will not do anything, because it is the
      // absence of a folder rather than the presence of one.
      return roots.length
        ? [...folderRows, folderRow(UNSORTED_FOLDER, roots)]
        : folderRows;
    },
    buildItems(id) {
      if (id === 'fixtures') return this.prepareFixtures();
      if (id === 'objects') return this.objectRows();
      if (id === 'structures') {
        const structures = this.$show.structureLibrary || {};
        return Object.keys(structures).map((name) => ({
          name,
          icon: 'structure',
          structure: name,
          more: `${(structures[name].members || []).length}`,
        }));
      }
      return [];
    },
    /**
     * Routes a list selection to whatever the active kind expects.
     *
     * @public
     * @async
     * @param {Object} item selected list entry
     */
    /**
     * Picks a model in the object browser.
     *
     * @public
     * @param {Object} model a library entry
     */
    selectObjectModel(model) {
      this.selectedObject = model;
      this.fixture.name = model.name;
      this.patchError = false;
    },
    /**
     * Double-clicking a tile picks it and places it, since that is the only
     * thing anyone opened this dialog to do.
     *
     * @public
     * @param {Object} model
     */
    confirmObjectModel(model) {
      this.selectObjectModel(model);
      this.submit();
    },
    /**
     * Picks a model file, copies it into the library and opens the dialog that
     * describes it.
     *
     * @public
     * @async
     */
    async importObject() {
      if (!window.library || !window.library.importObject) return;
      const result = await window.library.importObject();
      if (!result || !result.ok) {
        if (result && result.reason && result.reason !== 'cancelled') {
          // eslint-disable-next-line no-console
          console.warn(`[import] ${result.reason}`);
        }
        return;
      }
      this.pendingImport = result;
      this.importObjectPopupState = true;
    },
    /**
     * Shows a model just imported, picked and ready to place.
     *
     * @public
     * @async
     * @param {String} key its library key
     */
    async handleObjectImported(key) {
      this.pendingImport = null;
      await this.loadObjects();
      const model = this.objects.find((entry) => entry.key === key);
      if (model) this.selectObjectModel(model);
    },
    async selectItem(item) {
      if (this.activeKind === 'fixtures') {
        this.selectedItem = item || null;
        this.selectedRowId = item && item.id !== undefined ? item.id : null;
        if (item && item.share) {
          this.selectShareFixture(item.share);
          return;
        }
        if (item && item.shareAccount) {
          this.clearFixture();
          if (item.id === 'share/login' && this.$refs.shareAccount) this.$refs.shareAccount.openLogIn();
          return;
        }
        await this.loadFixture(item);
        return;
      }
      if (this.activeKind === 'structures' && item && item.structure) {
        this.selectedStructure = item.structure;
        this.fixture.name = item.structure;
        this.patchError = false;
        return;
      }
      if (this.activeKind === 'objects' && item && item.object) {
        this.selectedObject = item.object;
        this.fixture.name = item.object.name;
        this.patchError = false;
      }
    },
    /**
     * Writes the selected profile as a MadMapper fixture definition.
     *
     * `avoidCrossUniversePixels` comes from the same checkbox that drives our
     * own addressing, so the two applications are told the same thing rather
     * than being configured separately and drifting.
     *
     * @public
     * @async
     */
    async exportToMadMapper() {
      const contents = this.madMapperDocument;
      if (!contents || !window.fileExport) return;
      const written = await window.fileExport.save({
        contents,
        defaultName: `${this.madMapperProduct.replace(/[<>:"/\\|?*]/g, ' ').trim()}.mmfl`,
        startIn: 'madmapperFixtures',
        folderKey: 'madmapper-fixture',
        title: 'Export fixture to MadMapper',
        filters: [{ name: 'MadMapper fixture', extensions: ['mmfl'] }],
      });
      if (written) {
        this.exported = true;
        setTimeout(() => { this.exported = false; }, EXPORT_FEEDBACK_MS);
      }
    },
    /**
     * Loads a GDTF fixture for placing: its fixture type, read once by the
     * show, and the mode listing the form counts channels from.
     *
     * @public
     * @async
     * @param {Object} item a list entry, `fixture` holding the GDTF key
     */
    async loadGdtfFixture(item) {
      const type = await this.$show.loadGdtfType(item.fixture);
      if (!type) {
        Object.assign(this.fixture, { name: item.name, loaded: false, share: null });
        return;
      }
      const [manufacturer, model] = item.fixture.split('/');
      const listing = Fixture.gdtfListing(type);
      Object.assign(this.fixture, {
        share: null,
        OFLData: listing,
        fixtureType: type,
        modes: listing.modes,
        modeNames: listing.modes.map((mode) => mode.name),
        mode: 0,
        name: type.name,
        model,
        manufacturer,
        category: listing.categories[0],
        universeAligned: false,
        loaded: true,
      });
      this.patchError = false;
      this.autoPatch();
    },
    async loadFixture(item) {
      // Folders are selectable, since a row's click selects rather than
      // folds, so a manufacturer arrives here as well as a profile. It carries
      // no fixture to load.
      if (!item || !item.manufacturer || !item.fixture) return;
      if (item.gdtf) {
        await this.loadGdtfFixture(item);
        return;
      }
      const { manufacturer } = item;
      const { fixture } = item;
      // Profiles the app made -- this show's own, or the library's -- are not
      // served: there is no file to fetch, and asking for one would 404.
      const generated = this.$show.localProfile(`${manufacturer.name}/${fixture}`);
      // Fetched here rather than through `fetchProfile`, so the grid a matrix
      // profile only *describes* has to be written out here too -- otherwise
      // the channel counts below would size the patch from an insert that
      // stands for a hundred channels and counts as one.
      const data = generated
        ? JSON.parse(JSON.stringify(generated))
        : normaliseMatrixProfile(await fetchJson(`${import.meta.env.VITE_STATIC_URL}fixtures/${manufacturer.name}/${fixture}`));
      Object.assign(this.fixture, {
        share: null,
        OFLData: data,
        fixtureType: null,
        modes: data.modes,
        modeNames: data.modes.map((mode) => mode.name),
        // Back to the first, because a mode index means nothing across
        // profiles: 8-bit on a Spica is mode 1, and a display has only a
        // Default, so a carried-over index leaves every `modes[mode]` in here
        // reading undefined -- a crash on insert.
        mode: 0,
        name: data.name,
        model: fixture,
        manufacturer: manufacturer.name,
        category: data.categories[0],
        universeAligned: Fixture.profileKeepsPixelsWhole(data),
        loaded: true,
      });
      this.patchError = false;
      this.autoPatch();
    },
    /**
     * Checks that provided patch configuration is valid
     *
     * @public
     */
    checkPatch() {
      // The guarded reader, not the raw index: a mode that does not exist is a
      // fixture with nothing to patch, not a crash.
      const chCount = this.modeChannelCount;
      // Nothing to place, so nothing can be in the way. `canPatch` answers
      // false for a run of nought, which is the right answer to the question it
      // is asked and the wrong one to ask -- it would read as "those channels
      // are already taken" for a projector that wants no channels at all.
      if (chCount <= 0) {
        this.patchError = false;
        this.chStop = 0;
        return true;
      }
      if (this.$show.patch.canPatchMany(
        this.patchAddress,
        chCount,
        this.amount,
        this.alignmentPixelSize,
      )) {
        this.patchError = false;
        this.chStop = this.runStop(this.patchAddress, chCount);
        return true;
      }
      this.patchError = true;
      return false;
    },
    /**
     * One past the last channel a batch would occupy.
     *
     * Read off where the fixtures really land rather than multiplied out: a
     * run that keeps its pixels whole steps over the tail of each universe it
     * fills, so it ends later than its channel count says.
     *
     * @public
     * @param {Number} address absolute start address
     * @param {Number} chCount per-fixture channel count
     * @return {Number} absolute address one past the run's last channel
     */
    runStop(address, chCount) {
      const pixelSize = this.alignmentPixelSize;
      const run = this.$show.patch.addressRun(address, chCount, this.amount, pixelSize);
      if (!run.length) return address;
      return channelAddress(run[run.length - 1], chCount - 1, pixelSize) + 1;
    },
    /**
     * Finds the first free run in the show's address space. A run that crosses
     * a universe boundary is fine; only a full space is a failure.
     *
     * @public
     */
    autoPatch() {
      // Amount is shared by every kind, so this fires for a structure too,
      // which has no channels to find room for. The default fixture carries
      // an empty mode rather than none, so there is nothing to measure before
      // a profile is loaded either.
      if (!this.addressable || !this.fixture.loaded) return;
      // With the patch not strict, the address typed is the address used.
      if (!this.$show.patch.strict) {
        this.checkPatch();
        return;
      }
      // The guarded reader. `loadFixture` calls this the moment a profile
      // lands, so a mode index that does not exist reaches it before anything
      // else has a chance to notice.
      const chCount = this.modeChannelCount;
      const address = this.$show.patch.findFreeAddress(
        chCount,
        this.amount,
        this.startAddress || 0,
        this.alignmentPixelSize,
      );
      if (address > -1) {
        this.patchError = false;
        this.patchAddress = address;
        this.chStop = this.runStop(address, chCount);
      } else {
        this.patchError = true;
        this.chStop = 0;
      }
    },
    /**
     * Prepare fixture list
     *
     * @todo this shouldn't be called in a watcher. it might (and does) waste event loop time.
     * @public
     */
    prepareFixtures() {
      const keyOf = (entry, folder) => this.rowKey({
        gdtf: entry.gdtf,
        fixture: entry.file,
        manufacturer: entry.manufacturer ? { name: entry.manufacturer } : folder,
      });
      // Every entry with what the filters ask of it, counted for the funnel
      // before any are taken out.
      const counts = { type: {}, origin: {} };
      const folders = this.$show.rawOFLFixtures.map((manufacturer) => ({
        manufacturer,
        entries: manufacturer.fixtures.map((entry) => {
          const key = keyOf(entry, manufacturer);
          const profile = entry.generated ? this.$show.generatedProfiles[key] : null;
          const facts = {
            entry,
            profile,
            type: this.entryIcon(entry, profile),
            origin: fixtureOrigin(entry.gdtf, profile),
            bad: !!this.marks.files[key],
            favourite: !!this.marks.favourite.files[key],
          };
          counts.type[facts.type] = (counts.type[facts.type] || 0) + 1;
          counts.origin[facts.origin] = (counts.origin[facts.origin] || 0) + 1;
          return facts;
        }),
      }));
      this.facetCounts = counts;
      return folders.map(({ manufacturer, entries }) => ({
        id: `folder/${manufacturer.name}`,
        name: manufacturer.name,
        icon: 'folder',
        unfold: entries
          .filter((f) => this.passesFilters(f.bad, f.favourite)
            && inFacet(this.facetFilter.type, f.type)
            && inFacet(this.facetFilter.origin, f.origin))
          .map(({
            entry, type, origin, bad, favourite,
          }) => {
            // An entry under "This show" is not filed under a manufacturer
            // folder and carries its own; everything else takes the folder's.
            const maker = entry.manufacturer ? { name: entry.manufacturer } : manufacturer;
            const more = [
              bad ? 'marked bad' : null,
              favourite ? 'favourite' : null,
              entry.supported ? entry.category : `${entry.category} (not rendered)`,
              entry.gdtf && this.newerByKey.has(entry.file) ? 'newer on GDTF Share' : null,
            ].filter(Boolean).join(' · ');
            return {
              id: `fixture/${manufacturer.name}/${entry.file}`,
              // The profile's own name, rather than its filename.
              name: entry.name,
              // Fixtures the visualizer has no 3D model for still patch and
              // hold addresses, but draw nothing; the icon says which is which.
              icon: bad ? 'disabled' : type,
              more,
              tag: origin,
              manufacturer: maker,
              fixture: entry.file,
              gdtf: !!entry.gdtf,
              fixtureTypeId: entry.fixtureTypeId || null,
              revision: entry.revision || null,
            };
          }),
        // Whether the folder had fixtures before the filters took any out.
        filled: manufacturer.fixtures.length > 0,
      }))
        // A folder whose fixtures are all filtered out is not listed, nor an
        // empty one while any filter asks for something.
        .filter((folder) => folder.unfold.length || (!folder.filled
          && this.badFilter !== 'only' && this.favouriteFilter !== 'only'
          && !Object.values(this.facetFilter).some((ids) => ids && ids.length)));
    },
  },
};
</script>

<style scoped>
.kind_tabs {
  padding: 6px 6px 0;
  gap: 4px;
}
.kind_empty {
  padding: 12px;
  color: var(--secondary-light-alt);
  text-align: center;
}
.fixture_list_column {
  /* The list keeps whatever width it had; the actions row sits under it. */
  min-height: 0;
}
.fixture_list_actions {
  padding: 8px;
  border-top: 1px solid var(--primary-dark);
  border-right: 1px solid var(--primary-dark);
  /* Two labelled buttons side by side is what the column is sized for; if a
     label ever grows past it they wrap rather than squashing into each other. */
  flex-wrap: wrap;
}
.patch_popup {
  height: 100%;
}
.patch_form {
  min-width: 340px;
}
.patch_form_subsection {
  margin-bottom: unset;
}
.fixture_list {
  height: 350px;
  /* Wide enough for the two actions underneath -- "create generic" beside
     "to MadMapper" -- rather than for the list alone, which left them cramped
     against each other. */
  width: 380px;
  max-height: 350px;
  overflow: hidden;
  border-right: 1px solid var(--primary-dark);
}
.field {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
  width: 55px;
}
.field_label {
  margin-bottom: 8px;
}
.patch_button {
  margin-left: 8px;
}
.patch_error {
  color: #ce3d3db3;
}
h4 {
  margin-bottom: 8px;
}
.form_validation {
  display: flex;
  border-top: 1px solid var(--primary-dark);
  padding: 8px;
  width: 100%;
}
</style>
