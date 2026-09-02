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
        <!-- Non-breaking spaces, because the ordinary ones either side of the
             bold were being eaten somewhere between here and the screen: it
             rendered as "every<b>Beatline Projector 2</b>in". An entity is a
             character rather than whitespace, so nothing can condense it. -->
        Applies to every&nbsp;<b>{{ fixture.manufacturer }} {{ fixture.model }}</b
        >&nbsp;in the show.
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

      <!-- What the model *is*, above the map of what it answers to. This is
           the profile-scoped widget, and a resolution, a pitch and a throw are
           properties of the model rather than of this placement -- so they
           belong here beside the channel map rather than in Fixture Settings
           with the things you set per unit. It also fills the space a device
           with few channels, or none, otherwise leaves empty. -->
      <div
        v-if="deviceFacts.length"
        class="device_facts"
      >
        <dl>
          <template
            v-for="fact in deviceFacts"
            :key="fact.label"
          >
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </template>
        </dl>
      </div>

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

      <!-- A bar's channels are one thing repeated, so they are described
           rather than listed. See `barSummary`. -->
      <div
        v-if="barSummary"
        class="channel_map"
      >
        <dl class="bar_summary">
          <template
            v-for="fact in barSummary"
            :key="fact.label"
          >
            <dt>{{ fact.label }}</dt>
            <dd>{{ fact.value }}</dd>
          </template>
        </dl>
      </div>
      <div
        v-if="barSummary"
        class="channel_map bar_sample"
      >
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
            </tr>
          </thead>
          <tbody>
            <template
              v-for="row in barSample"
              :key="row.index"
            >
              <tr v-if="row.gap">
                <td
                  class="gap"
                  colspan="4"
                >
                  {{ row.gap }}
                </td>
              </tr>
              <tr v-else>
                <td class="num">
                  {{ row.index }}
                </td>
                <td class="num">
                  {{ row.address }}
                </td>
                <td>{{ row.name }}</td>
                <td class="function">
                  {{ row.function }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div
        v-else
        class="channel_map"
      >
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
import { pixelFill, pixelPitch, displayCurve } from '@/models/DMX/generic/display';
import {
  throwRange, throwAngles, imageSizeAt, illuminanceAt,
} from '@/models/DMX/generic/projector';
import { DEFAULT_PAN_SPEED, DEFAULT_TILT_SPEED } from '@/models/DMX/fixture.model';
import { fixtureIcon } from '@/models/DMX/generic/kinds';

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
     * What this model is, for a projector or a display.
     *
     * Read off the profile, so it speaks for every one of them in the show --
     * which is this widget's whole remit. A bar already has `barSummary` doing
     * the same job a few lines below; this is that idea for the video devices.
     *
     * @type {Array}
     */
    deviceFacts() {
      const asls = (this.fixture && this.fixture.OFLData && this.fixture.OFLData.asls) || {};
      if (asls.display) return this.displayFacts(asls.display);
      if (asls.projector) return this.projectorFacts(asls.projector);
      return [];
    },
    /**
     * Widget title, naming the model rather than the fixture: everything in
     * here is a property of the profile, not of the selected instance.
     *
     * @type {String}
     */
    header() {
      // The icon says which kind of fixture these settings belong to. It used
      // to be `grid` either way, which is the uikit widget's own placeholder
      // and meant nothing here.
      if (!this.fixture) return { title: 'Model', icon: 'fixture' };
      const mode = this.fixture.mode ? ` — ${this.fixture.mode.name}` : '';
      const count = this.fixture.channels ? ` (${this.fixture.channels.length} ch)` : '';
      return {
        title: `${this.fixture.model}${mode}${count}`,
        icon: fixtureIcon(this.fixture),
      };
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
      // A bar is described by `barSummary` instead. Listing it would be
      // 49,152 rows for a 128 x 128 and 196,608 for a 256 x 256 -- around six
      // DOM elements each, so a third of a million and over a million
      // respectively, which is what made selecting one slow. The rows carry
      // nothing to read: every one of them says the same thing about a
      // different pixel.
      if (!this.fixture || !this.fixture.channels || this.fixture.isBar) return [];
      return this.allChannelRows();
    },
    /**
     * A bar's channel map, as the handful of numbers that fully describe it.
     *
     * Null for anything that is not a generated bar, which is what the table
     * above keys off. Every fixture in the shipped library is at most 127
     * channels, so the table is only ever a problem for the ones we generate.
     *
     * @type {Array|null}
     */
    barSummary() {
      const { fixture } = this;
      if (!fixture || !fixture.isBar || !fixture.channels) return null;
      const { bar } = fixture.OFLData.asls;
      const total = fixture.channels.length;
      if (!total) return null;

      const pixels = (bar.columns || 0) * (bar.rows || 0);
      const perPixel = fixture.channelsPerPixel;
      // The end comes from `addressOf`, never from start + count: a fixture
      // keeping its pixels whole steps over 511-512 of every universe, so its
      // last channel sits further out than the count alone implies.
      const first = fixture.addressOf(0);
      const last = fixture.addressOf(total - 1);
      const at = (address) => `U${Math.floor(address / 512)}:${(address % 512) + 1}`;

      const wiring = [
        bar.scanAxis === 'column' ? 'down columns' : 'along rows',
        `from ${String(bar.startCorner || 'top-left').replace('-', ' ')}`,
      ];
      if (bar.serpentine) wiring.push('serpentine');

      return [
        { label: 'Grid', value: `${bar.columns} x ${bar.rows}  (${pixels.toLocaleString()} pixels)` },
        { label: 'Components', value: `${String(bar.order || '').toUpperCase()}  (${perPixel} per pixel)` },
        { label: 'Channels', value: total.toLocaleString() },
        { label: 'Span', value: `${at(first)}  to  ${at(last)}` },
        { label: 'Universes', value: (Math.floor(last / 512) - Math.floor(first / 512) + 1).toLocaleString() },
        { label: 'Wiring', value: wiring.join(', ') },
        {
          label: 'Pixels kept whole',
          value: fixture.universeAligned ? 'yes, skips 511-512' : 'no, may straddle',
        },
      ];
    },
    /**
     * The first and last pixel of a bar, as sample rows.
     *
     * The summary says what the pattern is; these show it, and confirm the
     * addressing at both ends of a run that may cross two hundred universes.
     *
     * @type {Array}
     */
    barSample() {
      const { fixture } = this;
      if (!this.barSummary) return [];
      const total = fixture.channels.length;
      const perPixel = fixture.channelsPerPixel;
      const head = [];
      const tail = [];
      for (let i = 0; i < Math.min(perPixel, total); i += 1) head.push(this.rowAt(i));
      for (let i = Math.max(perPixel, total - perPixel); i < total; i += 1) {
        tail.push(this.rowAt(i));
      }
      if (!tail.length) return head;
      const hidden = total - head.length - tail.length;
      return hidden > 0
        ? [...head, { index: -1, gap: `${hidden.toLocaleString()} more channels` }, ...tail]
        : [...head, ...tail];
    },
  },
  methods: {
    /**
     * A display's specification, in the order someone reads one.
     *
     * @public
     * @param {Object} p the profile's `asls.display`
     * @returns {Array}
     */
    displayFacts(p) {
      const wide = Math.round(p.pixelsWide);
      const high = Math.round(p.pixelsHigh);
      const fill = pixelFill(p);
      const pitch = pixelPitch(p);
      const diagonal = Math.sqrt((p.width * 1000) ** 2 + (p.height * 1000) ** 2) / 25.4;
      const lit = fill.x >= 0.999 && fill.y >= 0.999
        ? 'pixels meet'
        : `${Math.round(fill.x * 100)}% x ${Math.round(fill.y * 100)}% of each cell`;
      const facts = [
        { label: 'Takes', value: `${wide} x ${high} video` },
        { label: 'Panel', value: `${(p.width * 1000).toFixed(0)} x ${(p.height * 1000).toFixed(0)} mm · ${diagonal.toFixed(0)}"` },
        { label: 'Pitch', value: `${pitch.toFixed(2)} mm · ${(p.pixelSize * 1000).toFixed(1)} mm pixel · ${lit}` },
        { label: 'Brightness', value: `${p.nits} nits` },
      ];
      // Only when it is bent. The arc and the chord are both worth saying: the
      // arc is the width in pixels, the chord is the room it actually takes up,
      // and they are the two numbers you need to butt panels together.
      const curve = displayCurve(p, p.width + (Number(p.bezel) || 0) * 2);
      if (curve.radius) {
        // The angle leads because it is what was asked for; the radius and the
        // chord follow because they are what it works out to. The chord is the
        // room it actually takes up, which is the number for butting panels
        // together -- the width is arc length and stays what it was.
        const chord = 2 * curve.radius * Math.sin(curve.angle / 2);
        facts.push({
          label: 'Curve',
          value: `${((curve.angle * 180) / Math.PI).toFixed(1)}° ${curve.sign > 0 ? 'convex' : 'concave'}`
            + ` · r ${(curve.radius * 1000).toFixed(0)} mm · spans ${(chord * 1000).toFixed(0)} mm`,
        });
      }
      return facts;
    },
    /**
     * A projector's specification.
     *
     * @public
     * @param {Object} p the profile's `asls.projector`
     * @returns {Array}
     */
    projectorFacts(p) {
      const { min, max } = throwRange(p);
      const wide = throwAngles(min, p);
      const narrow = throwAngles(max, p);
      const at5 = imageSizeAt(5, min, p);
      const zoom = min === max ? `${min} : 1 prime` : `${min} - ${max} : 1`;
      return [
        { label: 'Throws', value: `${p.pixelsWide} x ${p.pixelsHigh} video` },
        { label: 'Lens', value: `${zoom} · ${narrow.horizontal.toFixed(1)}° to ${wide.horizontal.toFixed(1)}°` },
        { label: 'At 5 m', value: `up to ${at5.width.toFixed(2)} x ${at5.height.toFixed(2)} m` },
        // Lumens on their own say nothing about how a projection will read: the
        // same machine is brilliant on a small image and washed out on a big
        // one. Lux is what lands on the wall, so the rating and the throw are
        // said together. Twenty metres because that is where a machine mapping
        // a building tends to stand -- and it scales with the square, so half
        // the distance is four times this.
        {
          label: 'Output',
          value: `${p.lumens} lm · ${p.contrast}:1 · ${illuminanceAt(20, min, p).toFixed(0)} lux at 20 m`,
        },
      ];
    },
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
    /**
     * One table row for one channel.
     *
     * @public
     * @param {Number} index 0-based channel index
     * @returns {Object}
     */
    rowAt(index) {
      const channel = this.fixture.channels.at
        ? this.fixture.channels.at(index)
        : this.fixture.channels[index];
      return {
        index: index + 1,
        // Addresses are shown 1-based throughout the app.
        address: this.fixture.addressOf(index) + 1,
        name: channel.name || channel.type || 'Unset',
        function: channel.type || '—',
        isFine: !!channel.isFine,
        default: channel.value ? channel.value.DMX : 0,
      };
    },
    /**
     * Every channel as a row, however many there are.
     *
     * A method rather than a computed, because for a bar this is the thing
     * being avoided: it exists for Copy map, where the user has asked for the
     * full list and can wait for it.
     *
     * @public
     * @returns {Array}
     */
    allChannelRows() {
      if (!this.fixture || !this.fixture.channels) return [];
      return this.fixture.channels.map((channel, index) => ({
        index: index + 1,
        address: this.fixture.addressOf(index) + 1,
        name: channel.name || channel.type || 'Unset',
        function: channel.type || '—',
        isFine: !!channel.isFine,
        default: channel.value ? channel.value.DMX : 0,
      }));
    },
    async copyMap() {
      const lines = [
        ['#', 'Addr', 'Channel', 'Function', 'Default'].join('\t'),
        // The full list, built here rather than read off `channelRows`, which
        // is empty for a bar. Copy is where a bar's every channel is still
        // wanted, and the only place that should pay for them.
        ...this.allChannelRows().map((row) => [
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
/* Laid out like `bar_summary` below, because it answers the same kind of
   question about a different kind of fixture. */
.device_facts dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0 0 4px;
}
.device_facts dt {
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.device_facts dd {
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter);
  margin: 0;
}
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
.bar_summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  margin: 0;
  padding: 8px;
  font-family: Roboto-Regular;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bar_summary dt {
  color: var(--secondary-lighter-alt);
  white-space: nowrap;
}
.bar_summary dd {
  margin: 0;
  color: var(--secondary-lighter);
}
.bar_sample {
  margin-top: 6px;
}
.gap {
  text-align: center;
  color: var(--secondary-lighter-alt);
  font-style: italic;
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
