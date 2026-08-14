<template>
  <uk-popup
    v-model="state"
    :valid="fixture.loaded && !patchError && !loading"
    :header="headerData"
    @submit="patchFixtures"
    @input="update()"
  >
    <uk-flex class="patch_popup">
      <uk-flex
        col
        class="fixture_list_column"
      >
        <uk-list
          class="fixture_list"
          :items="fixtures"
          filterable
          @select="loadFixture"
        />
        <uk-flex class="fixture_list_actions">
          <uk-button
            icon="new"
            label="create generic"
            @click="createPopupState = true"
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
              :disabled="!fixture.loaded || loading"
              style="flex: 1"
              label="Name"
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
          </uk-flex>
          <uk-flex
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
              label="Skip ch 511-512"
              style="align-self: center"
              @input="checkPatch"
            />
            <uk-num-input
              v-model="amount"
              :disabled="!fixture.loaded || loading"
              class="field"
              label="Amount"
              :min="1"
              :max="512"
              @input="autoPatch"
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
              label="Fixture type"
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
                  label="Pos X"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.position.y"
                  label="Pos Y"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.position.z"
                  label="Pos Z"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading"
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
                  label="Offset X"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="positionOffsets.y"
                  label="Offset Y"
                  :min="-1000"
                  :max="1000"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="positionOffsets.z"
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
                  label="°Rot X"
                  :max="360"
                  :disabled="!fixture.loaded || loading"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.rotation.y"
                  label="°Rot Y"
                  :max="360"
                  :disabled="!fixture.loaded || loading"
                  class="field"
                />
                <uk-num-input
                  v-model="fixture.rotation.z"
                  label="°Rot Z"
                  :max="360"
                  :disabled="!fixture.loaded || loading"
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
                  label="°Offset X"
                  :max="360"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="rotationOffsets.y"
                  label="°Offset Y"
                  :max="360"
                  :disabled="!fixture.loaded || loading || amount <= 1"
                  class="field"
                />
                <uk-num-input
                  v-model="rotationOffsets.z"
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
  </uk-popup>
</template>

<script>
import PopupMixin from '@/views/mixins/popup.mixin';
import { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';

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

import CreateFixturePopup from './popup.create.fixture.vue';

export default {
  name: 'UkPopupPatch',
  components: {
    CreateFixturePopup,
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
  data() {
    return {
      headerData: { title: 'Patch fixture' },
      createPopupState: false,
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
      this.fixtures = this.prepareFixtures();
      this.fixture = JSON.parse(JSON.stringify(DEFAULT_FIXTURE_DATA));
      this.amount = DEFAULT_FIXTURE_AMOUNT;
      this.positionOffsets = { x: 0, y: 0, z: 0 };
      this.rotationOffsets = { x: 0, y: 0, z: 0 };
      this.chStop = 0;
      this.patchAddress = this.startAddress || 0;
      this.patchError = false;
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
            for (let i = 0; i < this.amount; i++) {
              this.fixture.address = i * chCount + this.patchAddress;
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
            }
            this.loading = false;
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
     * Icon for a list entry: generated fixtures read as a different kind of
     * thing from library profiles, and unrendered ones from both.
     *
     * @public
     * @param {Object} entry fixture list entry
     * @returns {String} icon name
     */
    entryIcon(entry) {
      if (entry.generated) return 'grid';
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
    async handleProfileCreated(key) {
      this.fixtures = this.prepareFixtures();
      const [manufacturer, model] = key.split('/');
      await this.loadFixture({ manufacturer: { name: manufacturer }, fixture: model });
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
      const data = generated
        ? JSON.parse(JSON.stringify(generated))
        : (await this.$http.get(`${import.meta.env.VITE_STATIC_URL}fixtures/${manufacturer.name}/${fixture}`)).data;
      Object.assign(this.fixture, {
        OFLData: data,
        modes: data.modes,
        modeNames: data.modes.map((mode) => mode.name),
        name: data.name,
        model: fixture,
        manufacturer: manufacturer.name,
        category: data.categories[0],
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
        this.fixture.universeAligned,
      )) {
        this.patchError = false;
        this.chStop = chCount * this.amount + this.patchAddress;
        return true;
      }
      this.patchError = true;
      return false;
    },
    /**
     * Finds the first free run in the show's address space. A run that crosses
     * a universe boundary is fine; only a full space is a failure.
     *
     * @public
     */
    autoPatch() {
      const chCount = this.fixture.modes[this.fixture.mode].channels.length;
      const address = this.$show.patch.findFreeAddress(
        chCount,
        this.amount,
        this.startAddress || 0,
        this.fixture.universeAligned,
      );
      this.chStop = chCount * this.amount + address;
      if (address > -1) {
        this.patchError = false;
        this.patchAddress = address;
      } else {
        this.patchError = true;
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
.fixture_list_column {
  /* The list keeps whatever width it had; the actions row sits under it. */
  min-height: 0;
}
.fixture_list_actions {
  padding: 8px;
  border-top: 1px solid var(--primary-dark);
  border-right: 1px solid var(--primary-dark);
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
  width: 300px;
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
