<template>
  <uk-widget
    class="fixture_settings"
    dockable
    :header="header"
  >
    <uk-flex
      v-if="fixture"
      :gap="8"
      col
      class="fixture_settings_body"
    >
      <uk-flex :gap="8">
        <uk-txt-input
          v-model.lazy="name"
          style="flex: 1"
          label="Name"
        />
      </uk-flex>
      <uk-flex :gap="8">
        <uk-num-input
          v-model.lazy="universe"
          style="width: 70px"
          class="field"
          label="Universe"
          :min="0"
          :max="32767"
        />
        <uk-num-input
          v-model.lazy="channel"
          style="width: 70px"
          class="field"
          label="Channel"
          :min="1"
          :max="512"
        />
        <uk-txt-input
          v-show="spanHint"
          :model-value="spanHint"
          readonly
          style="flex: 1"
          label="Spans"
        />
      </uk-flex>
      <uk-checkbox
        v-show="canSpan"
        v-model="universeAligned"
        label="Prevent cross universe pixels"
      />
      <uk-txt-input
        v-model="fixture.model"
        readonly
        label="Model"
      />
      <uk-select-input
        v-if="fixture.modeIndex != null"
        v-model="fixture.modeIndex"
        label="Mode"
        :options="fixture.modeNames"
      />
      <uk-checkbox
        v-if="canCastShadow"
        v-model="castsShadow"
        :disabled="shadowBudgetSpent"
        :label="shadowLabel"
      />

      <!-- A video device's own settings live here for the same reason the
           shadow tick above does: they belong to *this* placement, and a
           fixture's placement settings are what this widget is. The Model
           widget beside it is profile-scoped -- it speaks for every device of
           the model -- so a projector's throw *range* belongs there and its
           throw ratio belongs here. Every row shows whether or not a channel
           drives it: most projectors and most displays have no DMX at all,
           plenty have a couple of channels and nothing else, and the panel
           must not change shape between them. -->
      <template v-if="device">
        <!-- Optics only for a projector: a screen has no lens to zoom or
             shift. Everything below is shared, because a source, a dimmer and
             a blank mean the same thing to both. -->
        <template v-if="isProjector">
          <span class="section_label">Optics</span>
          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('zoom')"
              style="width: 92px"
              label="Throw ratio"
              :precision="2"
              :min="device.range.min"
              :max="device.range.max"
              :disabled="device.isDriven('zoom') || !device.zooms"
              @update:model-value="writeDevice('zoom', $event)"
            />
            <span class="hint">{{ throwHint }}</span>
            <span
              v-if="device.isDriven('zoom')"
              class="driven"
            >{{ drivenBy('zoom') }}</span>
          </uk-flex>

          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('shiftH')"
              style="width: 92px"
              label="Shift H %"
              :precision="1"
              :min="-device.shiftLimitH"
              :max="device.shiftLimitH"
              :disabled="device.isDriven('shiftH') || !device.shiftLimitH"
              @update:model-value="writeDevice('shiftH', $event)"
            />
            <uk-num-input
              :model-value="read('shiftV')"
              style="width: 92px"
              label="Shift V %"
              :precision="1"
              :min="-device.shiftLimitV"
              :max="device.shiftLimitV"
              :disabled="device.isDriven('shiftV') || !device.shiftLimitV"
              @update:model-value="writeDevice('shiftV', $event)"
            />
            <span
              v-if="device.isDriven('shiftH') || device.isDriven('shiftV')"
              class="driven"
            >DMX</span>
          </uk-flex>

          <!-- Per edge, because the end machine of an array ramps on its inner
               edge only: ramping both would fade the outside of the picture
               against nothing. No DMX, because a blend is set once when the rig
               is built and never ridden from a desk. -->
          <span class="section_label">Soft edge %</span>
          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-num-input
              :model-value="read('blendLeft')"
              style="width: 72px"
              label="Left"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendLeft', $event)"
            />
            <uk-num-input
              :model-value="read('blendRight')"
              style="width: 72px"
              label="Right"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendRight', $event)"
            />
            <uk-num-input
              :model-value="read('blendTop')"
              style="width: 72px"
              label="Top"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendTop', $event)"
            />
            <uk-num-input
              :model-value="read('blendBottom')"
              style="width: 72px"
              label="Bottom"
              :precision="1"
              :min="0"
              :max="45"
              @update:model-value="writeDevice('blendBottom', $event)"
            />
          </uk-flex>
        </template>

        <span class="section_label">{{ isLaser ? 'Input' : 'Output' }}</span>

        <!-- A laser says how it is fed: which protocol it presents itself as,
             and for a DAC which of the machine's addresses it lives at. That
             pair is what decides how many lasers a protocol can carry -- Ether
             Dream and LaserCube name a device by its address alone, so one
             laser each, while IDN offers a named service per laser at one
             address. -->
        <template v-if="isLaser">
          <uk-flex
            :gap="8"
            class="row"
          >
            <uk-select-input
              :model-value="protocolIndex"
              style="flex: 1"
              label="Protocol"
              :options="protocolOptions"
              @input="pickProtocol"
            />
            <uk-select-input
              v-if="usesAddress"
              :model-value="addressIndex"
              style="flex: 1"
              label="Address"
              :options="addressOptions"
              @input="pickAddress"
            />
          </uk-flex>
          <uk-flex
            v-if="usesStream"
            :gap="8"
            class="row"
          >
            <uk-select-input
              :model-value="sourceIndex"
              style="flex: 1"
              label="Stream"
              :options="sourceOptions"
              @input="pickSource"
            />
          </uk-flex>
          <span class="hint">{{ inputStatus }}</span>
        </template>

        <uk-flex
          v-if="!isLaser"
          :gap="8"
          class="row"
        >
          <uk-select-input
            :model-value="sourceIndex"
            style="flex: 1"
            label="Source"
            :options="sourceOptions"
            :disabled="device.isDriven('source')"
            @input="pickSource"
          />
          <span
            v-if="device.isDriven('source')"
            class="driven"
          >{{ drivenBy('source') }}</span>
        </uk-flex>

        <!-- Projector and display: a plain dimmer and blank. A laser carries a
             fuller output stage, below, so its dimmer lives there instead. -->
        <uk-flex
          v-if="!isLaser"
          :gap="8"
          class="row"
        >
          <uk-num-input
            :model-value="Math.round(read('dimmer') || 0)"
            style="width: 92px"
            label="Dimmer %"
            :precision="0"
            :min="0"
            :max="100"
            :disabled="device.isDriven('dimmer')"
            @update:model-value="writeDevice('dimmer', $event)"
          />
          <uk-checkbox
            :model-value="!!read('shutter')"
            :label="isProjector ? 'Shutter open' : 'Picture on'"
            :disabled="device.isDriven('shutter')"
            @update:model-value="writeDevice('shutter', $event)"
          />
          <span
            v-if="device.isDriven('dimmer') || device.isDriven('shutter')"
            class="driven"
          >DMX</span>
        </uk-flex>

        <!-- A laser's output stage: what it lays over the DAC's stream, grouped
             and laid out across so it is not one tall column. A fixed parameter
             is baked in the profile and dropped from the panel; a driven one is
             greyed and holds the live DMX value; an adjustable one is yours to
             set here. -->
        <template v-if="isLaser">
          <template
            v-for="group in laserGroups"
            :key="group.label"
          >
            <span class="section_label">{{ group.label }}</span>
            <uk-flex
              :gap="6"
              class="control_wrap"
            >
              <uk-num-input
                v-for="row in group.rows"
                v-show="!device.isFixed(row.key)"
                :key="row.key"
                :model-value="Math.round(read(row.key) || 0)"
                :style="{ width: `${row.width}px` }"
                :label="row.label"
                :precision="0"
                :min="row.min"
                :max="row.max"
                :disabled="device.isDriven(row.key)"
                @update:model-value="writeDevice(row.key, $event)"
              />
              <uk-checkbox
                v-if="group.shutter && !device.isFixed('shutter')"
                :model-value="!!read('shutter')"
                label="Shutter open"
                :disabled="device.isDriven('shutter')"
                @update:model-value="writeDevice('shutter', $event)"
              />
              <uk-checkbox
                v-for="toggle in (group.toggles || [])"
                v-show="!device.isFixed(toggle.key)"
                :key="toggle.key"
                :model-value="!!read(toggle.key)"
                :label="toggle.label"
                :disabled="device.isDriven(toggle.key)"
                @update:model-value="writeDevice(toggle.key, $event)"
              />
            </uk-flex>
          </template>
        </template>
      </template>
    </uk-flex>
  </uk-widget>
</template>

<script>
import { DMX_UNIVERSE_LENGTH } from '@/models/DMX/patch.model';
import { MAX_SHADOW_CASTERS } from '@/plugins/visualizer/moving_head';
import { imageSizeAt } from '@/models/DMX/generic/projector';
import { GENERIC_KINDS } from '@/models/DMX/generic/kinds';
import LaserStream from '@/plugins/laser_stream';
import Laser from '@/plugins/visualizer/laser';
import { LASER_PROTOCOLS, PROTOCOL_LABELS } from '@/models/DMX/laser_settings';

/**
 * The Ponk stream list always begins with "first live one", so a laser that
 * has never been pointed at anything still shows something.
 */
const PONK_AUTO = { value: null, label: '— first live stream —' };

/** Protocols that advertise a device, and so need an address to live at. */
const ADDRESSED = ['idn', 'etherdream', 'lasercube'];

/** How often the Ponk stream list is re-read while a laser is shown, in ms. */
const STREAM_POLL_MS = 1000;

export default {
  name: 'FixtureModifierWidgetSettings',
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
      /**
       * Bumped on a timer while a laser is shown, so a MadMapper output that
       * starts publishing appears in the Source list without a click.
       */
      streamTick: 0,
      streamTimer: null,
      /** The machine's bindable addresses, read once from the main process. */
      laserAddresses: [],
      /**
       * Widget header data
       */
      header: {
        title: 'Fixture Settings',
        icon: 'wrench',
      },
      /**
       * Bumped on every device write, to re-read the settings.
       *
       * They are a plain model, and DMX writes into them from outside Vue
       * entirely, so nothing here re-evaluates on its own. Same staleness the
       * video popup hit reading a frame's size off a class instance.
       */
      deviceRevision: 0,
    };
  },
  computed: {
    /**
     * Whether this fixture can cast a shadow at all. An emitter bar has no
     * beam behind which to cast one, so it is not offered the choice.
     *
     * @type {Boolean}
     */
    canCastShadow() {
      return !!(this.fixture && this.fixture.canCastShadow);
    },
    /**
     * This projector's placement settings, or null for anything else.
     *
     * @type {Object|null}
     */
    device() {
      return (this.fixture && this.fixture.device) || null;
    },
    /** A screen has no lens, so the Optics rows are a projector's alone. */
    isProjector() {
      return !!(this.fixture && this.fixture.deviceKind === GENERIC_KINDS.PROJECTOR);
    },
    /** A laser carries the output stage below rather than a plain dimmer. */
    isLaser() {
      return !!(this.fixture && this.fixture.deviceKind === GENERIC_KINDS.LASER);
    },
    /**
     * The laser's output stage, grouped and laid out several across so the
     * panel is not a tall single column. A fixed parameter is dropped from the
     * panel; a driven one is shown greyed, holding the live DMX value.
     *
     * @type {Array}
     */
    laserGroups() {
      const pct = (key, label, min = 0, width = 92) => ({
        key, label, min, max: 100, width,
      });
      return [
        { label: 'Intensity', rows: [pct('dimmer', 'Dimmer %')], shutter: true },
        {
          label: 'Colour %',
          rows: [pct('red', 'Red', 0, 62), pct('green', 'Green', 0, 62), pct('blue', 'Blue', 0, 62)],
        },
        {
          label: 'Geometry %',
          rows: [
            pct('xScale', 'X scale'), pct('yScale', 'Y scale'),
            pct('xPos', 'X pos', -100), pct('yPos', 'Y pos', -100),
          ],
          // Mounting flips sit with the geometry because that is what they are:
          // the field turned over, not the content changed.
          toggles: [
            { key: 'mirrorX', label: 'Mirror X' },
            { key: 'mirrorY', label: 'Mirror Y' },
          ],
        },
      ];
    },
    /**
     * Everything the projector rows show, read in one place.
     *
     * Carrying `projectorRevision` in is what makes a write, or a channel
     * arriving, reach the screen -- see the data property for why.
     *
     * @type {Object|null}
     */
    deviceState() {
      const at = this.deviceRevision;
      const { device } = this;
      if (!device) return null;
      return {
        at,
        zoom: device.value('zoom'),
        shiftH: device.value('shiftH'),
        shiftV: device.value('shiftV'),
        dimmer: device.value('dimmer'),
        shutter: device.value('shutter'),
        source: device.value('source'),
        // The laser output stage. Undefined for any device without these, which
        // reads as nothing to show -- the rows are gated on the kind anyway.
        red: device.value('red'),
        green: device.value('green'),
        blue: device.value('blue'),
        xScale: device.value('xScale'),
        yScale: device.value('yScale'),
        xPos: device.value('xPos'),
        yPos: device.value('yPos'),
      };
    },
    /** Every connector in the show, with an unbound entry at the top. */
    connectors() {
      return (this.$show && this.$show.videoConnectors) || [];
    },
    /** How this laser is fed. */
    protocol() {
      return (this.isLaser && this.read('protocol')) || 'ponk';
    },
    /** Only a laser advertising a device needs an address. */
    usesAddress() {
      return this.isLaser && ADDRESSED.includes(this.protocol);
    },
    /** Only Ponk has several streams arriving at once to choose between. */
    usesStream() {
      return this.isLaser && this.protocol === 'ponk';
    },
    protocolOptions() {
      return LASER_PROTOCOLS.map((key) => PROTOCOL_LABELS[key] || key);
    },
    protocolIndex() {
      const at = LASER_PROTOCOLS.indexOf(this.protocol);
      return at < 0 ? 0 : at;
    },
    /**
     * The addresses this laser's device may be bound to.
     *
     * An address being listed is not a promise that a producer will find it --
     * MadMapper's discovery reached this machine's Ethernet address but not its
     * Wi-Fi one. The status line below is what tells the truth about that.
     */
    addressChoices() {
      const list = this.laserAddresses.map((a) => ({
        value: a.address,
        label: a.primary ? `${a.label} — default` : a.label,
      }));
      const bound = this.read('address');
      if (bound && !list.some((a) => a.value === bound)) {
        list.push({ value: bound, label: `${bound} (not on this machine)` });
      }
      return list;
    },
    addressOptions() {
      return this.addressChoices.map((a) => a.label);
    },
    addressIndex() {
      const bound = this.read('address');
      if (!bound) return 0;
      const at = this.addressChoices.findIndex((a) => a.value === bound);
      return at < 0 ? 0 : at;
    },
    /**
     * Every Ponk stream heard -- MadMapper's laser outputs by their own names
     * -- and, if the show binds this laser to a stream nobody is sending right
     * now, that one too, marked, so the binding is visible rather than
     * silently reading as the first live one.
     */
    laserSources() {
      // Read so a tick re-evaluates this; the stream list is not reactive.
      void this.streamTick; // eslint-disable-line no-void
      const list = [
        PONK_AUTO,
        ...LaserStream.ponkStreams().map((s) => ({
          value: `ponk:${s.id}`,
          label: s.live ? s.name : `${s.name} (quiet)`,
        })),
      ];
      const bound = this.device ? this.device.value('source') : null;
      if (typeof bound === 'string' && bound.startsWith('ponk:')
        && !list.some((source) => source.value === bound)) {
        list.push({ value: bound, label: `Ponk stream ${bound.slice(5)} (absent)` });
      }
      return list;
    },
    /**
     * What this laser's input is actually doing -- which is the question a
     * "scan" button would have been pressed to ask, answered without one.
     */
    inputStatus() {
      void this.streamTick; // eslint-disable-line no-void
      if (!this.isLaser) return '';
      const held = Laser.inputErrorFor && this.fixture
        ? Laser.inputErrorFor(this.fixture) : null;
      if (held) return `Not connected — ${held}.`;
      const report = LaserStream.report();
      if (this.protocol === 'ponk') {
        const bound = this.read('source');
        const id = typeof bound === 'string' && bound.startsWith('ponk:')
          ? Number(bound.slice(5)) : null;
        const stream = report.find((r) => r.protocol === 'ponk'
          && (id === null ? r.held > 0 : r.service === id));
        if (!stream) return 'Waiting — no Ponk stream. Turn on "Publish to PONK" in MadMapper.';
        return stream.live
          ? `Receiving from "${stream.name}".`
          : `"${stream.name}" has stopped sending.`;
      }
      const live = report.find((r) => r.protocol === this.protocol && r.live);
      const where = this.read('address') || 'the default address';
      if (!live) return `Listening on ${where} — nothing has connected yet.`;
      return `Receiving${live.rate ? ` at ${Math.round(live.rate / 1000)} kpps` : ''}.`;
    },
    sourceOptions() {
      // A laser's source is which Ponk stream feeds it, not a video connector.
      if (this.isLaser) return this.laserSources.map((source) => source.label);
      return ['— none —', ...this.connectors.map((c) => c.name)];
    },
    sourceIndex() {
      const value = this.read('source');
      if (this.isLaser) {
        const at = this.laserSources.findIndex((source) => source.value === value);
        return at < 0 ? 0 : at;
      }
      if (value === null || value === undefined) return 0;
      // A channel names a connector by position, one-based, which is what makes
      // `Source Select = 1` read as the first one. A hand-set value is an id,
      // which survives connectors being reordered.
      if (this.device.isDriven('source') && this.device.hasLive('source')) {
        return Math.min(Math.max(value, 0), this.connectors.length);
      }
      const at = this.connectors.findIndex((c) => c.id === value);
      return at < 0 ? 0 : at + 1;
    },
    /**
     * What the picture comes to at a plausible throw -- the number that says
     * whether a zoom setting covers the thing it is aimed at.
     *
     * @type {String}
     */
    throwHint() {
      if (!this.device) return '';
      const params = this.fixture.OFLData.asls.projector;
      const at = imageSizeAt(5, this.read('zoom'), params);
      const size = `at 5 m ${at.width.toFixed(2)} × ${at.height.toFixed(2)} m`;
      if (!this.device.zooms) return `prime · ${size}`;
      return `${this.device.range.min} – ${this.device.range.max} · ${size}`;
    },
    /**
     * Whether this fixture's beam casts a shadow.
     *
     * Per fixture and off by default. Shadow maps come out of a small fixed
     * pool the whole scene shares -- around sixteen on a typical GPU, counting
     * everything else that samples a texture -- so this is a few fixtures'
     * worth of budget to spend where it reads, not a switch to leave on.
     *
     * @type {Boolean}
     */
    castsShadow: {
      get() {
        return !!(this.fixture && this.fixture.castsShadow);
      },
      set(state) {
        if (this.fixture) this.fixture.castsShadow = state;
      },
    },
    /**
     * How many fixtures in the show are casting shadows.
     *
     * @type {Number}
     */
    shadowCasters() {
      return this.$show.fixturePool.fixtures.filter((f) => f.castsShadow).length;
    },
    /**
     * Whether the budget is gone.
     *
     * A fixture that is already casting is never blocked -- that would be a
     * tick you could not untick -- so this only ever stops the next one.
     *
     * @type {Boolean}
     */
    shadowBudgetSpent() {
      return !this.castsShadow && this.shadowCasters >= MAX_SHADOW_CASTERS;
    },
    /**
     * The label carries the count, so the limit is visible before it is hit
     * rather than appearing as a checkbox that mysteriously will not tick.
     *
     * @type {String}
     */
    shadowLabel() {
      return `Casts shadows (${this.shadowCasters}/${MAX_SHADOW_CASTERS})`;
    },
    /**
     * Universe the fixture starts in. Setting it slides the fixture by whole
     * universes, keeping its channel.
     */
    /**
     * Fixture name, kept unique across the show. Typing a name already in use
     * gains a number rather than being refused, so renaming never fails.
     *
     * @type {String}
     */
    name: {
      get() {
        return this.fixture ? this.fixture.name : '';
      },
      set(value) {
        if (!this.fixture) return;
        this.fixture.name = this.$show.fixturePool.uniqueName(value, this.fixture.id);
      },
    },
    universe: {
      get() {
        return this.fixture ? this.fixture.universe : 0;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.universe = Math.max(0, Number(value));
        }
      },
    },
    /**
     * 1-based start channel within that universe. A fixture whose channels run
     * past 512 continues into the next universe.
     */
    channel: {
      get() {
        return this.fixture ? this.fixture.chStart + 1 : 1;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.chStart = Math.max(0, Number(value) - 1);
        }
      },
    },
    /**
     * Names the universe a fixture runs on into, when it crosses a boundary.
     * Empty for the ordinary case, so the field stays out of the way.
     */
    spanHint() {
      if (!this.fixture || !this.fixture.channels.length) return '';
      const endUniverse = Math.floor((this.fixture.addressStop - 1) / DMX_UNIVERSE_LENGTH);
      return endUniverse > this.fixture.universe ? `→ U${endUniverse}` : '';
    },
    /**
     * Whether the fixture skips the last two channels of each universe, so its
     * channels tile 510 to a universe rather than running over the boundary.
     */
    universeAligned: {
      get() {
        return this.fixture ? this.fixture.universeAligned : false;
      },
      set(value) {
        if (this.fixture) {
          this.fixture.universeAligned = !!value;
        }
      },
    },
    /**
     * The skip changes nothing for a fixture too short to reach a boundary, so
     * the option stays hidden for the rest.
     */
    canSpan() {
      if (!this.fixture) return false;
      return this.fixture.chStart + this.fixture.channels.length > DMX_UNIVERSE_LENGTH;
    },
  },
  mounted() {
    // The Ponk stream list lives outside Vue; a timer is what makes a new
    // MadMapper output show up in the Source dropdown while it is open.
    this.streamTimer = setInterval(() => { this.streamTick += 1; }, STREAM_POLL_MS);
    LaserStream.addresses().then((list) => { this.laserAddresses = list || []; });
  },
  beforeUnmount() {
    if (this.streamTimer) clearInterval(this.streamTimer);
    this.streamTimer = null;
  },
  methods: {
    /**
     * One device attribute out of the snapshot.
     *
     * @public
     * @param {String} key attribute name
     * @returns {*}
     */
    read(key) {
      return this.deviceState ? this.deviceState[key] : null;
    },
    /**
     * The marker beside a driven row, and whether anything has arrived on it
     * yet -- a different question from whether a channel exists.
     *
     * @public
     * @param {String} key attribute name
     * @returns {String}
     */
    drivenBy(key) {
      if (!this.device) return '';
      return this.device.hasLive(key) ? 'DMX' : 'DMX · waiting';
    },
    /**
     * Writes a parked value and lets the renderer redraw the throw.
     *
     * @public
     * @param {String} key attribute name
     * @param {*} value
     */
    writeDevice(key, value) {
      if (!this.device) return;
      this.device.set(key, value);
      this.deviceRevision += 1;
      const model = this.fixture && this.fixture._3DModel;
      if (model && model.refresh) model.refresh();
    },
    /**
     * Binds this projector to a video connector, by id.
     *
     * @public
     * @param {Number} index into `sourceOptions`, nought being unbound
     */
    pickSource(index) {
      if (!this.device) return;
      if (this.isLaser) {
        // Index 0 is the first live stream (null); otherwise the chosen one.
        this.writeDevice('source', (this.laserSources[index] || {}).value || null);
        return;
      }
      const connector = index > 0 ? this.connectors[index - 1] : null;
      // Through `writeDevice` rather than writing here: that is the one path
      // that also tells the renderer to redraw, and picking a source without it
      // left a display black until some *other* field was touched. Two write
      // paths differing in what each remembered to do -- the exact shape that
      // has bitten this app before.
      this.writeDevice('source', connector ? connector.id : null);
    },
    /**
     * Sets how this laser is fed.
     *
     * @public
     * @param {Number} index into `protocolOptions`
     */
    pickProtocol(index) {
      const protocol = LASER_PROTOCOLS[index];
      if (!protocol || protocol === this.protocol) return;
      this.writeDevice('protocol', protocol);
      // A stream belongs to Ponk, so leaving one bound while the laser is fed
      // by a DAC would be a setting that says something untrue.
      if (protocol !== 'ponk' && this.read('source')) this.writeDevice('source', null);
    },
    /**
     * Binds this laser's device to one of the machine's addresses.
     *
     * @public
     * @param {Number} index into `addressOptions`
     */
    pickAddress(index) {
      const choice = this.addressChoices[index];
      this.writeDevice('address', choice ? choice.value : null);
    },
  },
};
</script>

<style scoped>
.fixture_settings {
  max-width: 230px;
  min-width: 230px;
}
.fixture_settings_body {
  height: 100%;
  width: 100%;
  overflow-y: auto;
  padding: 6px;
  max-width: 230px;
  min-width: 230px;
}
.empty_text {
  display: flex;
  flex: 1;
  flex-direction: row;
  align-items: center;
  color: var(--secondary-light);
  justify-content: center;
}

/* --- projector rows ---------------------------------------------------- */

/* Top, not centred: a row mixes a labelled field with a bare hint or a DMX
   marker, and centring floats the short ones half way down beside the tall
   ones. Every widget in this app lines its rows up at the top. */
.row {
  align-items: flex-start;
}
/* A group of output-stage fields, packed across and wrapping, so a laser's
   nine parameters do not run down one tall column. */
.control_wrap {
  flex-wrap: wrap;
  align-items: flex-start;
}
.section_label {
  font-family: Roboto-Medium, sans-serif;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
  border-bottom: 1px solid var(--primary-dark);
  padding-bottom: 4px;
}
.hint {
  font-family: Roboto-Regular, sans-serif;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
  margin: 0;
}
/* The marker that says a row is not yours to set. Teal rather than red: a
   channel owning a value is the normal state of a patched fixture, not a
   fault. */
.driven {
  font-family: Roboto-Medium, sans-serif;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--accent-teal);
  white-space: nowrap;
}
</style>
