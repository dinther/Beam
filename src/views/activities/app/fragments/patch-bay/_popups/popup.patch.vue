<template>
  <uk-popup
    v-model="state"
    :valid="submittable"
    :header="headerData"
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
        <uk-list
          class="fixture_list"
          :items="items"
          filterable
          @select="selectItem"
        />
        <h4
          v-if="!items.length"
          class="kind_empty"
        >
          {{ emptyMessage }}
        </h4>
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
            title="Not built yet. Copy a .glb into Library/Objects and it appears here."
            disabled
          />
        </uk-flex>
      </uk-flex>
      <uk-flex
        col
        class="patch_form"
      >
        <div style="padding: 10px">
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
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import { DMX_UNIVERSE_LENGTH, channelAddress } from '@/models/DMX/patch.model';
import { buildMadMapperFixture } from '@/models/DMX/generic/madmapper';
import Fixture from '@/models/DMX/fixture.model';
import { normaliseMatrixProfile } from '@/models/DMX/ofl_matrix';
import CreateFixturePopup from './popup.create.fixture.vue';
import CreateObjectPopup from './popup.create.object.vue';

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

/** What the root objects are gathered under once folders exist. */
const UNSORTED_FOLDER = 'Unsorted';

export default {
  name: 'UkPopupPatch',
  components: {
    CreateFixturePopup,
    CreateObjectPopup,
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
  },
  emits: ['placed'],
  data() {
    return {
      headerData: { title: 'Add to show' },
      createPopupState: false,
      createObjectPopupState: false,
      /**
       * What kind of thing is being added. The list cannot nest three deep --
       * fixtures already spend their one level on manufacturers -- so the
       * kinds are tabs rather than folders above them.
       */
      activeKind: 'fixtures',
      /** Path most recently exported to, shown briefly on the button. */
      exported: false,
      /**
       * The list for whichever kind is showing.
       *
       * Held as data and rebuilt whole, never as a computed: uk-list rewrites
       * the array it is given, wrapping each sub-item in place, so handing it
       * one that has already been through that produces doubly wrapped entries
       * and a row with no name.
       */
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
      return this.activeKind === 'fixtures';
    },
    /**
     * What to call this fixture in MadMapper.
     *
     * The profile's own name, not `model`: for a library fixture that is the
     * file it was loaded from, so exporting one produced a fixture called
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
      const { components } = (this.fixture.OFLData || {}).asls || {};
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
      // selected. This is not the list picking a default -- that was wrong and
      // is gone -- it is the outcome of an action they took.
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
            const chCount = this.fixture.modes[this.fixture.mode].channels.length;
            // Left as the profile's own name means the user did not name it,
            // so number it instead. Named fixtures are left exactly as typed.
            const profileName = this.fixture.OFLData.name;
            const autoName = this.fixture.name === profileName;
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
              // Recomputed per fixture: each one added raises the highest
              // number, so a batch numbers itself as it goes.
              this.fixture.name = autoName
                ? this.$show.fixturePool.numberedName(profileName)
                : this.$show.fixturePool.uniqueName(this.fixture.name);
              const fixture = this.$show.fixturePool.addRaw(
                JSON.parse(
                  JSON.stringify(this.fixture),
                ),
              );
              this.$show.patchFixture(fixture);
              // Collected rather than left empty: this list was already being
              // returned, and something has to name what was added.
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
     * Icon for a list entry: bars read as a different kind of thing from
     * library profiles, and unrendered ones from both.
     *
     * Generated is the test because generating one is how a bar comes to
     * exist: OFL cannot describe an emitter array, so every generated profile
     * is a bar and every bar is a generated profile.
     *
     * @public
     * @param {Object} entry fixture list entry
     * @returns {String} icon name
     */
    entryIcon(entry) {
      if (entry.generated) return 'ledbar';
      return entry.supported ? 'movinghead' : 'undef';
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
     * Save to library is a separate, deliberate act. That is the whole point of
     * the change -- creating used to mint a permanent library entry, so every
     * experiment was an artefact and none of them could be adjusted afterwards.
     *
     * Placed where the form's position and rotation say, exactly as a library
     * object would be, and the Add dialog closes because the job is done.
     *
     * @public
     * @async
     * @param {Object} params `{ type, name, size, color }`
     */
    async handleObjectCreated(params) {
      const spin = { ...this.fixture.rotation };
      const toRad = (deg) => (deg * Math.PI) / 180;
      let object = null;
      try {
        object = await this.$show.createObject(params, {
          position: { ...this.fixture.position },
          rotation: { x: toRad(spin.x), y: toRad(spin.y), z: toRad(spin.z) },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[objects] could not create ${params.name}: ${err.message}`);
        return;
      }
      if (!object) return;
      // Arrives selected, the same courtesy the structure and object paths
      // extend -- and it is what the new widget needs to edit.
      this.$emit('placed', { kind: 'object', ids: [object.id] });
      this.state = false;
      this.update();
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
    async selectItem(item) {
      if (this.activeKind === 'fixtures') {
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
        title: 'Export fixture to MadMapper',
        filters: [{ name: 'MadMapper fixture', extensions: ['mmfl'] }],
      });
      if (written) {
        this.exported = true;
        setTimeout(() => { this.exported = false; }, EXPORT_FEEDBACK_MS);
      }
    },
    async loadFixture(item) {
      // Folders are selectable now that a row's click selects rather than
      // folds, so a manufacturer arrives here as well as a profile. It carries
      // no fixture to load.
      if (!item || !item.manufacturer || !item.fixture) return;
      const { manufacturer } = item;
      const { fixture } = item;
      // Generated profiles are built in the app, not served: there is no file
      // to fetch, and asking for one would 404.
      const generated = this.$show.generatedProfiles[`${manufacturer.name}/${fixture}`];
      // Fetched here rather than through `fetchProfile`, so the grid a matrix
      // profile only *describes* has to be written out here too -- otherwise
      // the channel counts below would size the patch from an insert that
      // stands for a hundred channels and counts as one.
      const data = generated
        ? JSON.parse(JSON.stringify(generated))
        : normaliseMatrixProfile((await this.$http.get(`${import.meta.env.VITE_STATIC_URL}fixtures/${manufacturer.name}/${fixture}`)).data);
      Object.assign(this.fixture, {
        OFLData: data,
        modes: data.modes,
        modeNames: data.modes.map((mode) => mode.name),
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
      const chCount = this.fixture.modes[this.fixture.mode].channels.length;
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
      const chCount = this.fixture.modes[this.fixture.mode].channels.length;
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
      return this.$show.rawOFLFixtures.map((manufacturer) => ({
        name: manufacturer.name,
        icon: 'folder',
        unfold: manufacturer.fixtures.map((entry) => ({
          // The profile's own name, rather than its filename.
          name: entry.name,
          // Fixtures the visualizer has no 3D model for still patch and hold
          // addresses, but draw nothing; the icon says which is which.
          icon: this.entryIcon(entry),
          more: entry.supported ? entry.category : `${entry.category} (not rendered)`,
          manufacturer,
          fixture: entry.file,
        })),
      }));
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
