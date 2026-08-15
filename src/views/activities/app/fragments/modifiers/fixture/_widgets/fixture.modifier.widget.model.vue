<template>
  <uk-widget
    class="fixture_model"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="fixture"
      :gap="8"
      col
      class="fixture_model_body"
    >
      <p class="scope_note">
        Applies to every <b>{{ fixture.manufacturer }} {{ fixture.model }}</b> in the show.
      </p>

      <template v-if="hasHead">
        <uk-flex :gap="8">
          <uk-num-input
            v-model.lazy="panSpeed"
            style="width: 90px"
            label="Pan °/s"
            :min="1"
            :max="2000"
            :disabled="!panOverridden"
          />
          <uk-checkbox
            v-model="panOverridden"
            label="Override"
          />
        </uk-flex>

        <uk-flex :gap="8">
          <uk-num-input
            v-model.lazy="tiltSpeed"
            style="width: 90px"
            label="Tilt °/s"
            :min="1"
            :max="2000"
            :disabled="!tiltOverridden"
          />
          <uk-checkbox
            v-model="tiltOverridden"
            label="Override"
          />
        </uk-flex>
      </template>

      <uk-flex
        :gap="8"
        class="channel_map_header"
      >
        <span class="section_label">Channel map</span>
        <span style="flex: 1" />
        <uk-button
          :label="copyLabel"
          @click="copyMap"
        />
      </uk-flex>

      <div class="channel_map">
        <table>
          <thead>
            <tr>
              <th class="num">
                #
              </th>
              <th class="num">
                Addr
              </th>
              <th>Channel</th>
              <th>Function</th>
              <th class="num">
                Default
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in channelRows"
              :key="row.index"
            >
              <td class="num">
                {{ row.index }}
              </td>
              <td class="num">
                {{ row.address }}
              </td>
              <td>
                {{ row.name }}
                <span
                  v-if="row.isFine"
                  class="fine_tag"
                >fine</span>
              </td>
              <td class="function">
                {{ row.function }}
              </td>
              <td class="num">
                {{ row.default }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { DEFAULT_PAN_SPEED, DEFAULT_TILT_SPEED } from '@/models/DMX/fixture.model';

/** How long the copy button confirms for, in ms. */
const COPY_FEEDBACK_MS = 1500;

export default {
  name: 'FixtureModifierWidgetModel',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Handle to fixture instance
     */
    fixture: {
      type: Object,
      default: null,
    },
  },
  data() {
    return {
      copied: false,
      /**
       * Bumped whenever an override is written. The show is a plain class, not
       * a reactive object, so a computed reading its overrides would cache
       * forever; this gives those computeds something reactive to depend on.
       */
      revision: 0,
    };
  },
  computed: {
    /**
     * Widget title, naming the model rather than the fixture: everything in
     * here is a property of the profile, not of the selected instance.
     *
     * @type {String}
     */
    header() {
      if (!this.fixture) return { title: 'Model', icon: 'grid' };
      const mode = this.fixture.mode ? ` — ${this.fixture.mode.name}` : '';
      const count = this.fixture.channels ? ` (${this.fixture.channels.length} ch)` : '';
      return { title: `${this.fixture.model}${mode}${count}`, icon: 'grid' };
    },
    /**
     * Key the overrides file is indexed by.
     *
     * @type {String}
     */
    profileKey() {
      return this.fixture ? this.fixture.profileKey : '';
    },
    /**
     * Whether this fixture has a head that travels. Slew rates are meaningless
     * on anything else, and an LED bar has no pan or tilt at all.
     *
     * @type {Boolean}
     */
    hasHead() {
      const accessors = (this.fixture || {}).quickChannelsAccessors || {};
      return !!(accessors.Pan || accessors.Tilt);
    },
    /**
     * Overrides currently stored for this model.
     *
     * @type {Object}
     */
    overrides() {
      // eslint-disable-next-line no-unused-expressions
      this.revision;
      return this.$show.fixtureOverrides[this.profileKey] || {};
    },
    panOverridden: {
      get() {
        return this.overrides.panSpeed !== undefined;
      },
      set(state) {
        this.setOverrideState('panSpeed', state, DEFAULT_PAN_SPEED);
      },
    },
    tiltOverridden: {
      get() {
        return this.overrides.tiltSpeed !== undefined;
      },
      set(state) {
        this.setOverrideState('tiltSpeed', state, DEFAULT_TILT_SPEED);
      },
    },
    panSpeed: {
      get() {
        // eslint-disable-next-line no-unused-expressions
        this.revision;
        return this.fixture ? this.fixture.panSpeed : DEFAULT_PAN_SPEED;
      },
      set(value) {
        this.$show.setFixtureOverride(this.profileKey, 'panSpeed', Number(value));
        this.revision += 1;
      },
    },
    tiltSpeed: {
      get() {
        // eslint-disable-next-line no-unused-expressions
        this.revision;
        return this.fixture ? this.fixture.tiltSpeed : DEFAULT_TILT_SPEED;
      },
      set(value) {
        this.$show.setFixtureOverride(this.profileKey, 'tiltSpeed', Number(value));
        this.revision += 1;
      },
    },
    copyLabel() {
      return this.copied ? 'copied' : 'copy';
    },
    /**
     * One row per patched channel. The offset is what a profile editor asks
     * for; the address is what this fixture actually occupies, which is the
     * number to type into a controller.
     *
     * @type {Array}
     */
    channelRows() {
      if (!this.fixture || !this.fixture.channels) return [];
      return this.fixture.channels.map((channel, index) => ({
        index: index + 1,
        // Addresses are shown 1-based throughout the app.
        address: this.fixture.addressOf(index) + 1,
        name: channel.name || channel.type || 'Unset',
        function: channel.type || '—',
        isFine: !!channel.isFine,
        default: channel.value ? channel.value.DMX : 0,
      }));
    },
  },
  methods: {
    /**
     * Ticks or clears one override. Ticking freezes whatever is in effect now,
     * so checking the box never moves the fixture on its own.
     *
     * @public
     * @param {String} key override name
     * @param {Boolean} state whether the override should exist
     * @param {Number} fallback system default to restore when cleared
     */
    setOverrideState(key, state, fallback) {
      if (state) {
        this.$show.setFixtureOverride(this.profileKey, key, this.fixture[key]);
      } else {
        this.$show.clearFixtureOverride(this.profileKey, key, fallback);
      }
      this.revision += 1;
    },
    /**
     * Puts the channel map on the clipboard as tab-separated text, for pasting
     * into a controller's fixture editor.
     *
     * @public
     */
    async copyMap() {
      const lines = [
        ['#', 'Addr', 'Channel', 'Function', 'Default'].join('\t'),
        ...this.channelRows.map((row) => [
          row.index,
          row.address,
          row.name + (row.isFine ? ' (fine)' : ''),
          row.function,
          row.default,
        ].join('\t')),
      ];
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        this.copied = true;
        setTimeout(() => { this.copied = false; }, COPY_FEEDBACK_MS);
      } catch (err) {
        // Clipboard access can be refused; leaving the label alone is enough of
        // a signal that nothing was copied.
        this.copied = false;
      }
    },
  },
};
</script>

<style scoped>
.fixture_model_body {
  padding: 8px;
  min-width: 340px;
}
.scope_note {
  margin: 0;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
}
.scope_note b {
  color: var(--secondary-lighter);
}
.section_label {
  font-family: Roboto-Medium;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
}
.channel_map_header {
  align-items: center;
  border-top: 1px solid var(--primary-dark);
  padding-top: 8px;
}
.channel_map {
  /* Scrolls sideways only: the widget body carries the vertical scrollbar now,
     and two nested ones make the map awkward to reach. */
  overflow-x: auto;
  border: 1px solid var(--primary-dark);
  border-radius: 3px;
}
table {
  border-collapse: collapse;
  width: 100%;
  /* Typography is set per element app-wide rather than on body, so a table
     inherits nothing and would otherwise fall back to the browser serif. */
  font-family: Roboto-Regular;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
th {
  position: sticky;
  top: 0;
  background: var(--primary-lighter);
  text-align: left;
  font-family: Roboto-Medium;
  color: var(--secondary-lighter-alt);
  padding: 4px 8px;
  white-space: nowrap;
}
td {
  padding: 3px 8px;
  border-top: 1px solid var(--primary-dark);
  color: var(--secondary-lighter);
  white-space: nowrap;
}
.num {
  text-align: right;
}
.function {
  color: var(--secondary-lighter-alt);
}
.fine_tag {
  font-family: Roboto-Medium;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent-teal);
  margin-left: 4px;
}
</style>
