<template>
  <uk-popup
    v-model="state"
    cancelable
    backdrop
    :valid="valid"
    :header="headerData"
    @submit="create"
  >
    <uk-flex
      col
      :gap="8"
      class="create_form"
    >
      <uk-flex :gap="8">
        <uk-select-input
          v-model="kindIndex"
          style="width: 140px"
          label="Type"
          :options="kinds"
        />
        <!-- auto-update, because these two decide whether the name is taken
             and whether Create is allowed. Left to emit on blur, the warning
             described the previous name while the box showed the new one:
             type a unique model over a taken one and it still insisted the
             name existed until focus moved. -->
        <uk-txt-input
          v-model="manufacturer"
          auto-update
          style="flex: 1"
          label="Manufacturer"
        />
        <uk-txt-input
          v-model="model"
          auto-update
          style="flex: 1"
          label="Model"
        />
      </uk-flex>

      <p
        v-if="nameTaken"
        class="create_warning"
      >
        {{ manufacturer }} / {{ model }} already exists. Pick another name.
      </p>

      <template v-if="isBar">
        <span class="create_section">Body (mm)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="length"
            class="field"
            label="Length"
            :min="1"
            :max="20000"
          />
          <uk-num-input
            v-model="width"
            class="field"
            label="Width"
            :min="1"
            :max="2000"
          />
          <uk-num-input
            v-model="height"
            class="field"
            label="Height"
            :min="1"
            :max="2000"
          />
        </uk-flex>

        <span class="create_section">Pixels</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="columns"
            class="field"
            label="Columns"
            :min="1"
            :max="2000"
          />
          <uk-num-input
            v-model="rows"
            class="field"
            label="Rows"
            :min="1"
            :max="2000"
          />
          <uk-num-input
            v-model="marginEnds"
            class="field"
            label="Margin L/R"
            :min="0"
            :max="10000"
          />
          <uk-num-input
            v-model="marginSides"
            class="field"
            label="Margin T/B"
            :min="0"
            :max="1000"
          />
        </uk-flex>

        <span class="create_section">Emitters</span>
        <uk-flex :gap="8">
          <!-- Tenths, because emitters are small: a 3535 package is 3.5 mm and
               whole millimetres cannot say so. The steppers move by 0.1 to
               match, since they step one unit of the precision. -->
          <uk-num-input
            v-model="emitterSize"
            class="field"
            label="Size (mm)"
            :precision="1"
            :min="0.1"
            :max="100"
          />
          <uk-num-input
            v-model="beamAngle"
            class="field"
            label="Beam °"
            :min="10"
            :max="180"
          />
          <uk-select-input
            v-model="orderIndex"
            style="width: 110px"
            label="Wire order"
            :options="orders"
          />
        </uk-flex>

        <span class="create_section">Scan</span>
        <uk-flex :gap="8">
          <uk-select-input
            v-model="startCornerIndex"
            style="width: 150px"
            label="Starts at"
            :options="corners"
          />
          <uk-select-input
            v-model="scanAxisIndex"
            style="width: 130px"
            label="Runs along"
            :options="axes"
          />
          <uk-checkbox
            v-model="serpentine"
            label="Serpentine"
          />
          <uk-checkbox
            v-model="universeAligned"
            label="Prevent cross universe pixels"
          />
        </uk-flex>

        <p class="create_summary">
          {{ pixelCount }} pixels &middot; {{ channelCount }} channels &middot;
          {{ pitchHint }}
        </p>
      </template>

      <!-- A projector is described by what its spec sheet prints, which is a
           different handful of numbers entirely: there are no emitters and no
           wiring order, and the picture is a frustum rather than a grid. -->
      <template v-else-if="isProjector">
        <span class="create_section">Imager</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="pixelsWide"
            class="field"
            label="Pixels W"
            :min="320"
            :max="16384"
          />
          <uk-num-input
            v-model="pixelsHigh"
            class="field"
            label="Pixels H"
            :min="240"
            :max="16384"
          />
          <uk-num-input
            v-model="lumens"
            class="wide_field"
            label="ANSI lumens"
            :min="100"
            :max="100000"
          />
          <uk-num-input
            v-model="contrast"
            class="wide_field"
            label="Contrast :1"
            :min="100"
            :max="10000000"
          />
        </uk-flex>

        <span class="create_section">Optics</span>
        <uk-flex :gap="8">
          <!-- Hundredths, because a spec sheet quotes 1.44-2.32 and whole
               numbers cannot say so. The steppers move by one unit of the
               precision, as every number field here does. -->
          <uk-num-input
            v-model="throwMin"
            class="field"
            label="Throw min"
            :precision="2"
            :min="0.2"
            :max="20"
          />
          <uk-num-input
            v-model="throwMax"
            class="field"
            label="Throw max"
            :precision="2"
            :min="0.2"
            :max="20"
          />
          <uk-num-input
            v-model="shiftLimitH"
            class="field"
            label="Shift H %"
            :min="0"
            :max="200"
          />
          <uk-num-input
            v-model="shiftLimitV"
            class="field"
            label="Shift V %"
            :min="0"
            :max="200"
          />
        </uk-flex>

        <!-- A box with a barrel on the front, which is what a projector is
             from across a room. The two numbers that matter beyond its size are
             where the glass sits on that front panel: plenty of machines put it
             well off to one side, and a lens in the wrong place aims the whole
             image somewhere the model says it does not go. -->
        <span class="create_section">Body (mm)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="projectorWidth"
            class="field"
            label="Width"
            :min="1"
            :max="3000"
          />
          <uk-num-input
            v-model="projectorHeight"
            class="field"
            label="Height"
            :min="1"
            :max="3000"
          />
          <uk-num-input
            v-model="projectorDepth"
            class="field"
            label="Depth"
            :min="1"
            :max="3000"
          />
        </uk-flex>

        <span class="create_section">Lens placement (mm from centre of front)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="lensX"
            class="field"
            label="Across"
            :min="-1500"
            :max="1500"
          />
          <uk-num-input
            v-model="lensY"
            class="field"
            label="Up"
            :min="-1500"
            :max="1500"
          />
          <uk-num-input
            v-model="lensDiameter"
            class="field"
            label="Diameter"
            :min="1"
            :max="1000"
          />
          <uk-num-input
            v-model="lensProtrusion"
            class="field"
            label="Sticks out"
            :min="0"
            :max="1000"
          />
        </uk-flex>

        <!-- Drawn rather than rendered, and the difference is the point: every
             fixture in this app is near black, so a faithful picture of a
             projector is a dark blob on a dark ground. An elevation answers the
             question the numbers above actually raise -- where on the panel is
             the glass -- and it answers it at a glance. The centre lines are
             what make "across" and "up" mean anything. -->
        <span class="create_section">Elevation</span>
        <svg
          class="preview"
          :viewBox="`0 0 ${preview.w} ${preview.h}`"
          preserveAspectRatio="xMidYMid meet"
        >
          <g
            v-for="view in preview.views"
            :key="view.name"
          >
            <rect
              :x="view.x"
              :y="view.y"
              :width="view.w"
              :height="view.h"
              class="preview_body"
            />
            <!-- The datum the lens offsets are measured from. -->
            <line
              :x1="view.x"
              :y1="view.cy"
              :x2="view.x + view.w"
              :y2="view.cy"
              class="preview_datum"
            />
            <line
              v-if="view.cx !== null"
              :x1="view.cx"
              :y1="view.y"
              :x2="view.cx"
              :y2="view.y + view.h"
              class="preview_datum"
            />
            <rect
              v-if="view.barrel"
              :x="view.barrel.x"
              :y="view.barrel.y"
              :width="view.barrel.w"
              :height="view.barrel.h"
              class="preview_lens"
            />
            <circle
              v-if="view.lens"
              :cx="view.lens.cx"
              :cy="view.lens.cy"
              :r="view.lens.r"
              class="preview_lens"
            />
            <text
              :x="view.x"
              :y="view.y + view.h + 11"
              class="preview_label"
            >{{ view.name }}</text>
          </g>
        </svg>

        <!-- Most projectors have no DMX at all, and most of those that do offer
             a shutter and a dimmer and nothing else. So this is a choice rather
             than a consequence of the geometry, and none of them ticked is a
             legitimate projector that you aim by hand. -->
        <span class="create_section">DMX channels</span>
        <uk-flex
          :gap="12"
          class="ticks"
        >
          <uk-checkbox
            v-for="option in channelOptions"
            :key="option.key"
            v-model="channelsOn[option.key]"
            :label="option.label"
          />
        </uk-flex>

        <p
          v-if="lensWarning"
          class="create_warning"
        >
          {{ lensWarning }}
        </p>

        <p class="create_summary">
          {{ throwSummary }}
        </p>
        <p class="create_summary">
          {{ channelSummary }}
        </p>
      </template>

      <!-- A display is described by what it is, physically: the lit area, the
           border round it and how deep the box is. The pixel grid is separate
           because a wall's tiles rarely divide its outline evenly, and it is
           the outline the picture has to fill. -->
      <template v-else-if="isDisplay">
        <span class="create_section">Panel (mm)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="screenWidth"
            class="field"
            label="Width"
            :min="1"
            :max="100000"
          />
          <uk-num-input
            v-model="screenHeight"
            class="field"
            label="Height"
            :min="1"
            :max="100000"
          />
          <uk-num-input
            v-model="screenDepth"
            class="field"
            label="Depth"
            :min="1"
            :max="2000"
          />
          <uk-num-input
            v-model="screenBezel"
            class="field"
            label="Bezel"
            :min="0"
            :max="1000"
          />
        </uk-flex>
        <!-- An angle, not a radius: the width is fixed, so the two say the
             same thing, but only one of them is a number anybody has in mind.
             Signed, because the direction is one property of one surface --
             positive bulges towards the room like the outside of a pillar,
             negative wraps around it like a backdrop, zero is flat. -->
        <uk-flex :gap="8">
          <uk-num-input
            v-model="screenCurveAngle"
            class="wide_field"
            label="Curve ° (+ convex, − concave, 0 flat)"
            :precision="1"
            :min="-180"
            :max="180"
          />
        </uk-flex>

        <span class="create_section">Pixels</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="screenPixelsWide"
            class="field"
            label="Pixels W"
            :min="16"
            :max="32768"
          />
          <uk-num-input
            v-model="screenPixelsHigh"
            class="field"
            label="Pixels H"
            :min="16"
            :max="32768"
          />
          <!-- Tenths, because a pixel is small: a fine-pitch wall runs a
               1.5 mm emitter in a 2.6 mm cell and whole millimetres cannot say
               so. The same field the LED bar creator calls emitter size. -->
          <uk-num-input
            v-model="pixelSize"
            class="field"
            label="Pixel (mm)"
            :precision="1"
            :min="0.1"
            :max="200"
          />
          <uk-num-input
            v-model="nits"
            class="wide_field"
            label="Nits"
            :min="10"
            :max="20000"
          />
        </uk-flex>

        <span class="create_section">Video</span>
        <p class="create_headline">
          {{ videoSummary }}
        </p>
        <p class="create_summary">
          {{ panelSummary }}
        </p>
        <p class="create_summary">
          {{ pixelSummary }}
        </p>

        <!-- Same argument as a projector's: most displays have no DMX socket
             at all, and one is still worth placing. -->
        <span class="create_section">DMX channels</span>
        <uk-flex
          :gap="12"
          class="ticks"
        >
          <uk-checkbox
            v-for="option in displayChannelOptions"
            :key="option.key"
            v-model="displayChannelsOn[option.key]"
            :label="option.label"
          />
        </uk-flex>

        <p class="create_summary">
          {{ displayChannelSummary }}
        </p>
      </template>

      <!-- A laser is a galvo pair and an aperture. Its picture comes from the
           DAC point stream, so nothing here describes colour or position -- only
           the machine: how much light it makes, how wide it can scan, how fine
           its beam is, and where the aperture sits on the box. -->
      <template v-else-if="isLaser">
        <span class="create_section">Scanner</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="power"
            class="field"
            label="Power W"
            :min="0.1"
            :max="100"
            :precision="1"
          />
          <uk-num-input
            v-model="scanAngleH"
            class="field"
            label="Scan H °"
            :min="1"
            :max="120"
          />
          <uk-num-input
            v-model="scanAngleV"
            class="field"
            label="Scan V °"
            :min="1"
            :max="120"
          />
          <uk-num-input
            v-model="maxPointRate"
            class="wide_field"
            label="Points/s"
            :min="1000"
            :max="200000"
          />
        </uk-flex>

        <span class="create_section">Beam</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="beamDiameter"
            class="field"
            label="Diameter mm"
            :min="0.1"
            :max="50"
            :precision="1"
          />
          <uk-num-input
            v-model="divergence"
            class="field"
            label="Divergence mrad"
            :min="0"
            :max="20"
            :precision="1"
          />
        </uk-flex>

        <span class="create_section">Body (mm)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="laserWidth"
            class="field"
            label="Width"
            :min="1"
            :max="3000"
          />
          <uk-num-input
            v-model="laserHeight"
            class="field"
            label="Height"
            :min="1"
            :max="3000"
          />
          <uk-num-input
            v-model="laserDepth"
            class="field"
            label="Depth"
            :min="1"
            :max="3000"
          />
        </uk-flex>

        <span class="create_section">Aperture (mm from centre of front)</span>
        <uk-flex :gap="8">
          <uk-num-input
            v-model="apertureX"
            class="field"
            label="Across"
            :min="-1500"
            :max="1500"
          />
          <uk-num-input
            v-model="apertureY"
            class="field"
            label="Up"
            :min="-1500"
            :max="1500"
          />
          <uk-num-input
            v-model="apertureDiameter"
            class="field"
            label="Diameter"
            :min="1"
            :max="1000"
          />
        </uk-flex>

        <!-- The picture is never on DMX; these ride an output stage over the
             stream. Each is Fixed (baked here), Adjustable (set per placement)
             or DMX (driven, at a relative channel and bit depth). All-Adjustable
             is a laser you correct by hand, the common case. -->
        <span class="create_section">Output stage</span>
        <uk-flex
          v-for="option in laserControlOptions"
          :key="option.key"
          :gap="8"
          class="control_row"
        >
          <span class="control_label">{{ option.label }}</span>
          <uk-select-input
            :model-value="laserControls[option.key].modeIndex"
            style="width: 120px"
            :options="controlModeLabels"
            @update:model-value="(v) => setControlMode(option.key, v)"
          />
          <template v-if="laserControls[option.key].modeIndex === 2">
            <uk-num-input
              v-model="laserControls[option.key].channel"
              class="field"
              label="Rel. channel"
              :min="1"
              :max="512"
            />
            <uk-select-input
              v-model="laserControls[option.key].bitsIndex"
              style="width: 100px"
              label="Depth"
              :options="controlBitLabels"
            />
          </template>
          <uk-num-input
            v-else
            v-model="laserControls[option.key].value"
            class="field"
            label="Value"
            :min="-100"
            :max="100"
          />
        </uk-flex>

        <p class="create_summary">
          {{ laserSummary }}
        </p>
      </template>
    </uk-flex>
  </uk-popup>
</template>

<script>
import {
  DEFAULT_BAR_PARAMS, START_CORNERS, SCAN_AXES, BAR_SHAPES,
} from '@/models/DMX/generic/led_bar';
import {
  DEFAULT_PROJECTOR_PARAMS, CHANNEL_ORDER, CHANNEL_LABELS, throwAngles,
} from '@/models/DMX/generic/projector';
import {
  DEFAULT_DISPLAY_PARAMS,
  CHANNEL_ORDER as DISPLAY_CHANNEL_ORDER,
  CHANNEL_LABELS as DISPLAY_CHANNEL_LABELS,
  pixelPitch,
  pixelFill,
} from '@/models/DMX/generic/display';
import {
  DEFAULT_LASER_PARAMS,
  CHANNEL_ORDER as LASER_CHANNEL_ORDER,
  CHANNEL_LABELS as LASER_CHANNEL_LABELS,
  imageSizeAt as laserImageSizeAt,
} from '@/models/DMX/generic/laser';
import { GENERIC_KINDS } from '@/models/DMX/generic/kinds';

/** Millimetres per metre: the form talks mm, the model talks metres. */
const MM = 1000;

/**
 * Option lists.
 *
 * uk-select-input models the selected *index*, not the value, so each of these
 * is paired with an index in data and read back through a computed.
 */
// What the thing is, which decides how other tools are told to draw it: a bar
// is a line with a thickness, a panel a rectangle. Separate from how many rows
// it carries -- a four-row batten is still a bar.
const KINDS = ['LED bar', 'LED panel', 'Projector', 'Display', 'Laser'];
const KIND_SHAPES = [BAR_SHAPES.BAR, BAR_SHAPES.PANEL, null, null, null];
// Which builder each kind goes to. Bars and panels differ in how they are
// drawn and described to other tools, not in what makes them -- so both come
// from the same builder; the projector, display and laser each add their own.
const KIND_BUILDERS = [
  GENERIC_KINDS.BAR, GENERIC_KINDS.BAR, GENERIC_KINDS.PROJECTOR,
  GENERIC_KINDS.DISPLAY, GENERIC_KINDS.LASER,
];
// The model name each kind starts out with. Changing the type renames the
// fixture to match, so the two do not sit there disagreeing -- but only while
// the name is still the one this dialog chose.
const KIND_NAMES = ['LED Bar', 'LED Panel', 'Projector', 'Display', 'Laser'];
// How a generic parameter is decided, and the bit depths a DMX one may use.
// The selects model an index, so these are the source of both the labels and
// the value each index maps to.
const CONTROL_MODES = ['fixed', 'adjustable', 'dmx'];
const CONTROL_MODE_LABELS = ['Fixed', 'Adjustable', 'DMX'];
const CONTROL_BITS = [8, 16, 24];
const CONTROL_BIT_LABELS = ['8-bit', '16-bit', '24-bit'];
// The value a laser's output-stage parameter parks at: full for the masters
// and scales, centred for the offsets, open for the shutter.
const LASER_CONTROL_DEFAULTS = {
  dimmer: 100,
  shutter: 100,
  red: 100,
  green: 100,
  blue: 100,
  xScale: 100,
  yScale: 100,
  xPos: 0,
  yPos: 0,
};
const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR', 'RGBW', 'GRBW', 'BGRW', 'RGBA', 'GRBA'];
const CORNERS = Object.values(START_CORNERS);
const AXES = Object.values(SCAN_AXES);

export default {
  name: 'CreateFixturePopup',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue', 'created'],
  data() {
    return {
      headerData: { title: 'Create generic fixture' },
      kindIndex: 0,
      kinds: KINDS,
      manufacturer: 'Beatline',
      model: KIND_NAMES[0],
      length: DEFAULT_BAR_PARAMS.length * MM,
      width: DEFAULT_BAR_PARAMS.width * MM,
      height: DEFAULT_BAR_PARAMS.height * MM,
      marginEnds: DEFAULT_BAR_PARAMS.marginEnds * MM,
      marginSides: DEFAULT_BAR_PARAMS.marginSides * MM,
      columns: DEFAULT_BAR_PARAMS.columns,
      rows: DEFAULT_BAR_PARAMS.rows,
      emitterSize: DEFAULT_BAR_PARAMS.emitterSize * MM,
      beamAngle: DEFAULT_BAR_PARAMS.beamAngle,
      orderIndex: Math.max(ORDERS.indexOf(DEFAULT_BAR_PARAMS.order), 0),
      orders: ORDERS,
      startCornerIndex: Math.max(CORNERS.indexOf(DEFAULT_BAR_PARAMS.startCorner), 0),
      corners: CORNERS,
      scanAxisIndex: Math.max(AXES.indexOf(DEFAULT_BAR_PARAMS.scanAxis), 0),
      axes: AXES,
      serpentine: DEFAULT_BAR_PARAMS.serpentine,
      universeAligned: DEFAULT_BAR_PARAMS.universeAligned,
      // Projector. Its body is kept apart from the bar's rather than shared,
      // because switching type back and forth would otherwise carry a 1 m
      // strip's dimensions onto a projector and quietly keep them.
      pixelsWide: DEFAULT_PROJECTOR_PARAMS.pixelsWide,
      pixelsHigh: DEFAULT_PROJECTOR_PARAMS.pixelsHigh,
      throwMin: DEFAULT_PROJECTOR_PARAMS.throwMin,
      throwMax: DEFAULT_PROJECTOR_PARAMS.throwMax,
      lumens: DEFAULT_PROJECTOR_PARAMS.lumens,
      contrast: DEFAULT_PROJECTOR_PARAMS.contrast,
      shiftLimitH: DEFAULT_PROJECTOR_PARAMS.shiftLimitH,
      shiftLimitV: DEFAULT_PROJECTOR_PARAMS.shiftLimitV,
      projectorWidth: DEFAULT_PROJECTOR_PARAMS.width * MM,
      projectorHeight: DEFAULT_PROJECTOR_PARAMS.height * MM,
      projectorDepth: DEFAULT_PROJECTOR_PARAMS.depth * MM,
      lensX: DEFAULT_PROJECTOR_PARAMS.lensX * MM,
      lensY: DEFAULT_PROJECTOR_PARAMS.lensY * MM,
      lensDiameter: DEFAULT_PROJECTOR_PARAMS.lensDiameter * MM,
      lensProtrusion: DEFAULT_PROJECTOR_PARAMS.lensProtrusion * MM,
      /** Ticked channels, keyed the way the profile stores them. */
      channelsOn: Object.fromEntries(CHANNEL_ORDER.map(
        (key) => [key, DEFAULT_PROJECTOR_PARAMS.channels.includes(key)],
      )),
      // Display. Kept apart from the projector's for the same reason that is:
      // switching type back and forth must not carry one machine's dimensions
      // onto another and quietly keep them.
      screenWidth: DEFAULT_DISPLAY_PARAMS.width * MM,
      screenHeight: DEFAULT_DISPLAY_PARAMS.height * MM,
      screenDepth: DEFAULT_DISPLAY_PARAMS.depth * MM,
      screenBezel: DEFAULT_DISPLAY_PARAMS.bezel * MM,
      screenPixelsWide: DEFAULT_DISPLAY_PARAMS.pixelsWide,
      screenPixelsHigh: DEFAULT_DISPLAY_PARAMS.pixelsHigh,
      pixelSize: DEFAULT_DISPLAY_PARAMS.pixelSize * MM,
      screenCurveAngle: DEFAULT_DISPLAY_PARAMS.curveAngle,
      nits: DEFAULT_DISPLAY_PARAMS.nits,
      displayChannelsOn: Object.fromEntries(DISPLAY_CHANNEL_ORDER.map(
        (key) => [key, DEFAULT_DISPLAY_PARAMS.channels.includes(key)],
      )),
      // Laser. Kept apart from the others for the same reason they are kept
      // apart from each other: switching type must not carry one machine's
      // numbers onto another and quietly keep them.
      power: DEFAULT_LASER_PARAMS.power,
      scanAngleH: DEFAULT_LASER_PARAMS.scanAngleH,
      scanAngleV: DEFAULT_LASER_PARAMS.scanAngleV,
      beamDiameter: DEFAULT_LASER_PARAMS.beamDiameter,
      divergence: DEFAULT_LASER_PARAMS.divergence,
      maxPointRate: DEFAULT_LASER_PARAMS.maxPointRate,
      laserWidth: DEFAULT_LASER_PARAMS.width * MM,
      laserHeight: DEFAULT_LASER_PARAMS.height * MM,
      laserDepth: DEFAULT_LASER_PARAMS.depth * MM,
      apertureX: DEFAULT_LASER_PARAMS.apertureX * MM,
      apertureY: DEFAULT_LASER_PARAMS.apertureY * MM,
      apertureDiameter: DEFAULT_LASER_PARAMS.apertureDiameter * MM,
      // One row per output-stage parameter: how it is decided, its parked or
      // baked value, and -- when DMX -- its relative channel and bit depth.
      // Everything starts Adjustable at its default, channels numbered in order
      // so a run of DMX ticks lands contiguously without thinking about it.
      laserControls: Object.fromEntries(LASER_CHANNEL_ORDER.map((key, i) => [key, {
        modeIndex: 1,
        value: LASER_CONTROL_DEFAULTS[key],
        channel: i + 1,
        bitsIndex: 0,
      }])),
    };
  },
  computed: {
    /**
     * Selected values, resolved from the indices the select components model.
     */
    order() {
      return ORDERS[this.orderIndex] || ORDERS[0];
    },
    shape() {
      return KIND_SHAPES[this.kindIndex] || KIND_SHAPES[0];
    },
    /** Which builder this kind goes to -- see `generic/kinds.js`. */
    builder() {
      return KIND_BUILDERS[this.kindIndex] || KIND_BUILDERS[0];
    },
    isBar() {
      return this.builder === GENERIC_KINDS.BAR;
    },
    isProjector() {
      return this.builder === GENERIC_KINDS.PROJECTOR;
    },
    isDisplay() {
      return this.builder === GENERIC_KINDS.DISPLAY;
    },
    isLaser() {
      return this.builder === GENERIC_KINDS.LASER;
    },
    /** One control row per output-stage parameter, in addressing order. */
    laserControlOptions() {
      return LASER_CHANNEL_ORDER.map((key) => ({ key, label: LASER_CHANNEL_LABELS[key] }));
    },
    /** Labels for the mode and bit-depth selects. */
    controlModeLabels() {
      return CONTROL_MODE_LABELS;
    },
    controlBitLabels() {
      return CONTROL_BIT_LABELS;
    },
    /**
     * The controls block, in the shape the model stores: one entry per
     * parameter with its mode, its parked/baked value, and -- for DMX -- the
     * relative channel and bit depth.
     *
     * @type {Object}
     */
    laserControlsOut() {
      return Object.fromEntries(LASER_CHANNEL_ORDER.map((key) => {
        const c = this.laserControls[key];
        return [key, {
          mode: CONTROL_MODES[c.modeIndex] || 'adjustable',
          value: c.value,
          channel: Math.max(1, Math.round(c.channel) || 1),
          bits: CONTROL_BITS[c.bitsIndex] || 8,
        }];
      }));
    },
    /**
     * The laser's parameters, as the model wants them. One place rather than
     * spelled out again in `create`, so the summary and the written profile
     * cannot disagree.
     *
     * @type {Object}
     */
    laserParams() {
      return {
        power: this.power,
        scanAngleH: this.scanAngleH,
        scanAngleV: this.scanAngleV,
        beamDiameter: this.beamDiameter,
        divergence: this.divergence,
        maxPointRate: this.maxPointRate,
        width: this.laserWidth / MM,
        height: this.laserHeight / MM,
        depth: this.laserDepth / MM,
        apertureX: this.apertureX / MM,
        apertureY: this.apertureY / MM,
        apertureDiameter: this.apertureDiameter / MM,
        controls: this.laserControlsOut,
      };
    },
    /**
     * How many DMX channels the laser occupies: the furthest byte any driven
     * parameter reaches.
     *
     * @type {Number}
     */
    laserFootprint() {
      let footprint = 0;
      LASER_CHANNEL_ORDER.forEach((key) => {
        const c = this.laserControls[key];
        if (CONTROL_MODES[c.modeIndex] !== 'dmx') return;
        const channel = Math.max(1, Math.round(c.channel) || 1);
        const bytes = (CONTROL_BITS[c.bitsIndex] || 8) / 8;
        footprint = Math.max(footprint, channel - 1 + bytes);
      });
      return footprint;
    },
    /**
     * What the scan comes to, in the terms someone aiming it thinks in: the
     * full angle, the picture at 10 m, and the DMX footprint.
     *
     * @type {String}
     */
    laserSummary() {
      const at10 = laserImageSizeAt(10, this.laserParams);
      const n = this.laserFootprint;
      return `${this.scanAngleH}° × ${this.scanAngleV}° scan`
        + ` · at 10 m fills ${at10.width.toFixed(1)} × ${at10.height.toFixed(1)} m`
        + ` · ${n} DMX channel${n === 1 ? '' : 's'}`;
    },
    /** The tick boxes, in the order the profile addresses them. */
    displayChannelOptions() {
      return DISPLAY_CHANNEL_ORDER.map((key) => ({ key, label: DISPLAY_CHANNEL_LABELS[key] }));
    },
    displayChannelKeys() {
      return DISPLAY_CHANNEL_ORDER.filter((key) => this.displayChannelsOn[key]);
    },
    /**
     * The display's parameters, as the model wants them.
     *
     * @type {Object}
     */
    displayParams() {
      return {
        width: this.screenWidth / MM,
        height: this.screenHeight / MM,
        depth: this.screenDepth / MM,
        bezel: this.screenBezel / MM,
        pixelsWide: this.screenPixelsWide,
        pixelsHigh: this.screenPixelsHigh,
        pixelSize: this.pixelSize / MM,
        curveAngle: this.screenCurveAngle,
        nits: this.nits,
        channels: this.displayChannelKeys,
      };
    },
    /**
     * What to feed it: the size of picture this panel wants, in pixels.
     *
     * The number someone carving a canvas needs, and the reason it leads rather
     * than sitting among the millimetres -- a wall is specified physically and
     * *fed* in pixels, and it is the second that has to match what a connector
     * hands over.
     *
     * @type {String}
     */
    videoSummary() {
      const wide = Math.round(this.screenPixelsWide);
      const high = Math.round(this.screenPixelsHigh);
      const mp = (wide * high) / 1e6;
      const ratio = this.aspectName(wide, high);
      const thousands = Math.round((wide * high) / 1000);
      const size = mp >= 1 ? `${mp.toFixed(2)} megapixels` : `${thousands}k pixels`;
      return `Takes ${wide} × ${high} video · ${ratio} · ${size}`;
    },
    /**
     * The panel's shape beside its pixel grid's, and the pitch between them.
     *
     * The two disagreeing is not an error -- plenty of walls are built that way
     * -- but it is what stretches a picture, so it is worth seeing while the
     * numbers are being typed rather than afterwards on the screen.
     *
     * @type {String}
     */
    panelSummary() {
      const panel = this.screenWidth / Math.max(this.screenHeight, 1);
      const pixels = this.screenPixelsWide / Math.max(this.screenPixelsHigh, 1);
      const pitch = pixelPitch(this.displayParams);
      const diagonal = Math.sqrt(this.screenWidth ** 2 + this.screenHeight ** 2) / 25.4;
      const shape = Math.abs(panel - pixels) < 0.01
        ? 'panel and pixels agree'
        : `panel ${panel.toFixed(2)}:1 but pixels ${pixels.toFixed(2)}:1 — the picture will stretch`;
      return `${diagonal.toFixed(0)}" diagonal · ${pitch.toFixed(2)} mm pitch · ${shape}`;
    },
    /**
     * What the pixel size comes to as a proportion of the cell.
     *
     * The number the shader actually works in, shown because the useful range
     * is not obvious from the millimetres alone: a pixel at or past the pitch
     * fills its cell and the grid disappears, which is right for an LCD and
     * wrong for a wall.
     *
     * @type {String}
     */
    pixelSummary() {
      const fill = pixelFill(this.displayParams);
      if (fill.x >= 0.999 && fill.y >= 0.999) {
        return 'Pixels meet — no visible grid, which is what an LCD looks like.';
      }
      const across = `${(fill.x * 100).toFixed(0)}%`;
      const down = `${(fill.y * 100).toFixed(0)}%`;
      const same = fill.x.toFixed(2) === fill.y.toFixed(2);
      const lit = same ? `${across} of each cell lit` : `${across} across and ${down} down each cell`;
      return `${lit} — the rest is dark ground between the pixels.`;
    },
    displayChannelSummary() {
      const count = this.displayChannelKeys.length;
      if (!count) return 'No DMX — set by hand';
      return `${count} channel${count === 1 ? '' : 's'}`;
    },
    /** The tick boxes, in the order the profile addresses them. */
    channelOptions() {
      return CHANNEL_ORDER.map((key) => ({ key, label: CHANNEL_LABELS[key] }));
    },
    projectorChannelKeys() {
      return CHANNEL_ORDER.filter((key) => this.channelsOn[key]);
    },
    /**
     * The projector's parameters, as the model wants them.
     *
     * One place rather than spelled out again in `create`, so the summary
     * below the form and the profile that gets written cannot disagree.
     *
     * @type {Object}
     */
    projectorParams() {
      return {
        pixelsWide: this.pixelsWide,
        pixelsHigh: this.pixelsHigh,
        throwMin: this.throwMin,
        throwMax: this.throwMax,
        lumens: this.lumens,
        contrast: this.contrast,
        shiftLimitH: this.shiftLimitH,
        shiftLimitV: this.shiftLimitV,
        width: this.projectorWidth / MM,
        height: this.projectorHeight / MM,
        depth: this.projectorDepth / MM,
        lensX: this.lensX / MM,
        lensY: this.lensY / MM,
        lensDiameter: this.lensDiameter / MM,
        lensProtrusion: this.lensProtrusion / MM,
        channels: this.projectorChannelKeys,
      };
    },
    /**
     * What the lens comes to, in the terms someone aiming it thinks in.
     *
     * A throw ratio is the number on the box, but the angle is what decides
     * whether the projector fits the room -- and the picture at 5 m is what
     * decides whether it covers the wall.
     *
     * @type {String}
     */
    throwSummary() {
      const wide = throwAngles(this.throwMin, this.projectorParams);
      const narrow = throwAngles(this.throwMax, this.projectorParams);
      const widest = (5 / this.throwMin);
      const narrowest = (5 / this.throwMax);
      const aspect = this.pixelsHigh / this.pixelsWide;
      return `${narrow.horizontal.toFixed(1)}° to ${wide.horizontal.toFixed(1)}° wide`
        + ` · at 5 m throws ${narrowest.toFixed(2)} × ${(narrowest * aspect).toFixed(2)} m`
        + ` to ${widest.toFixed(2)} × ${(widest * aspect).toFixed(2)} m`;
    },
    /**
     * The two elevations, laid out in the SVG's own units.
     *
     * Both views share one scale so they can be compared by eye -- a shallow
     * projector has to *look* shallow beside its own front panel, which it
     * would not if each view were fitted to the space it was given.
     *
     * The side view points right, so the front panel is the right-hand edge and
     * the barrel sticks out towards the picture it throws.
     *
     * @type {Object}
     */
    preview() {
      const w = 420;
      const h = 150;
      const pad = 10;
      const gap = 22;
      const label = 14;
      // Guarded: every one of these is a field the user is mid-way through
      // typing, and a zero or a blank here would divide by nothing.
      const bw = Math.max(this.projectorWidth, 1);
      const bh = Math.max(this.projectorHeight, 1);
      const bd = Math.max(this.projectorDepth, 1);
      const dia = Math.max(this.lensDiameter, 0);
      const out = Math.max(this.lensProtrusion, 0);

      const scale = Math.min(
        (w - pad * 2 - gap) / (bw + bd + out),
        (h - pad * 2 - label) / bh,
      );
      const top = pad + ((h - pad * 2 - label) - bh * scale) / 2;

      // Front: the panel square on, with the lens where it really sits. Up is
      // positive in the model and down the screen in an SVG, hence the negation.
      const frontW = bw * scale;
      const front = {
        name: 'Front',
        x: pad,
        y: top,
        w: frontW,
        h: bh * scale,
        cx: pad + frontW / 2,
        cy: top + (bh * scale) / 2,
        lens: {
          cx: pad + (bw / 2 + this.lensX) * scale,
          cy: top + (bh / 2 - this.lensY) * scale,
          r: (dia / 2) * scale,
        },
        barrel: null,
      };

      const sideX = pad + frontW + gap;
      const lensCy = top + (bh / 2 - this.lensY) * scale;
      const side = {
        name: 'Side',
        x: sideX,
        y: top,
        w: bd * scale,
        h: bh * scale,
        // No vertical datum: the lens has no across-offset in this view, so a
        // centre line down it would only invite reading the depth off it.
        cx: null,
        cy: top + (bh * scale) / 2,
        lens: null,
        barrel: {
          x: sideX + bd * scale,
          y: lensCy - (dia / 2) * scale,
          w: out * scale,
          h: dia * scale,
        },
      };

      return { w, h, views: [front, side] };
    },
    /**
     * Why Create is refused, when it is the lens that is wrong.
     *
     * A greyed-out button with no reason beside it is the thing being avoided
     * here: the numbers that clash are three sections apart, so nobody would
     * guess which one to change.
     *
     * @type {String}
     */
    lensWarning() {
      const radius = this.lensDiameter / 2;
      if (Math.abs(this.lensX) + radius > this.projectorWidth / 2) {
        return 'The lens hangs off the side of the front panel. Widen the body, '
          + 'move the lens in, or make it smaller.';
      }
      if (Math.abs(this.lensY) + radius > this.projectorHeight / 2) {
        return 'The lens hangs off the top or bottom of the front panel. Raise the '
          + 'body height, move the lens in, or make it smaller.';
      }
      return '';
    },
    channelSummary() {
      const count = this.projectorChannelKeys.length;
      if (!count) return 'No DMX — set by hand';
      return `${count} channel${count === 1 ? '' : 's'}`;
    },
    startCorner() {
      return CORNERS[this.startCornerIndex] || CORNERS[0];
    },
    scanAxis() {
      return AXES[this.scanAxisIndex] || AXES[0];
    },
    state: {
      get() {
        return this.modelValue;
      },
      set(value) {
        this.$emit('update:modelValue', value);
      },
    },
    pixelCount() {
      return Math.max(1, this.columns) * Math.max(1, this.rows);
    },
    channelCount() {
      return this.pixelCount * this.order.length;
    },
    /**
     * Spacing between adjacent pixels, which the margins and count imply
     * rather than the user setting it.
     *
     * @type {String}
     */
    pitchHint() {
      if (this.columns < 2) return 'single column';
      const span = this.length - this.marginEnds * 2;
      if (span <= 0) return 'margins exceed the length';
      return `${(span / (this.columns - 1)).toFixed(1)} mm pitch`;
    },
    nameTaken() {
      const key = `${this.manufacturer.trim()}/${this.model.trim()}`;
      return !!this.$show.generatedProfiles[key];
    },
    valid() {
      const named = !!this.manufacturer.trim() && !!this.model.trim() && !this.nameTaken;
      if (!named) return false;
      // A display has no channel rule either -- most have no DMX socket -- and
      // what it cannot be is a panel with no area.
      if (this.builder === GENERIC_KINDS.DISPLAY) {
        return this.screenWidth > 0 && this.screenHeight > 0 && this.screenDepth > 0;
      }
      // A laser is allowed no channels, like a projector. What it cannot have
      // is a body with no size, a scan that makes no picture, or an aperture
      // off the front panel it is measured from.
      if (this.isLaser) {
        const radius = this.apertureDiameter / 2;
        return this.laserWidth > 0 && this.laserHeight > 0 && this.laserDepth > 0
          && this.scanAngleH > 0 && this.scanAngleV > 0
          && Math.abs(this.apertureX) + radius <= this.laserWidth / 2
          && Math.abs(this.apertureY) + radius <= this.laserHeight / 2;
      }
      // A projector is allowed no channels at all, so the bar's "must address
      // something" rule would refuse the commonest projector there is. What it
      // cannot have is a lens that makes no picture.
      if (!this.isBar) {
        // A lens has to sit on the front panel it is measured from -- half the
        // width or height either side of centre, less its own radius.
        const radius = this.lensDiameter / 2;
        return this.throwMin > 0 && this.throwMax > 0
          && Math.abs(this.lensX) + radius <= this.projectorWidth / 2
          && Math.abs(this.lensY) + radius <= this.projectorHeight / 2;
      }
      return this.length > this.marginEnds * 2 && this.channelCount > 0;
    },
  },
  watch: {
    /**
     * Keeps the name with the type, until the user has an opinion about it.
     *
     * Whether they have one is asked of the field rather than remembered: a
     * name that still reads as the suggestion for the type it was offered
     * under is a name nobody has chosen. Tracking it instead took two pieces
     * of state -- the last name written and whether it had been overtyped --
     * and the flag outlived the dialog it described, so one rename stopped the
     * name following the type for the rest of the session.
     */
    kindIndex(index, previous) {
      if (this.model.trim() && this.model.trim() !== this.suggestionFor(previous)) return;
      this.model = this.suggestionFor(index);
    },
    state(open) {
      // No `update()` here, unlike the object dialog: this component does not
      // use PopupMixin. Its `state` is a computed whose setter emits
      // `update:modelValue` directly, so the parent is already in step and
      // there is nothing to forward -- and `this.update` does not exist.
      //
      // The dialog keeps its geometry between visits on purpose -- one bar is
      // usually followed by a variant of it -- but the name of the thing just
      // created is taken by definition, so reopening met a warning about a
      // name the user had not typed. Numbering it is what the rest of the app
      // does when a name collides.
      if (open) this.model = this.freeName();
    },
  },
  methods: {
    /**
     * The first relative channel no other DMX parameter is using.
     *
     * A parameter's byte span is its channel through `channel + bits/8 - 1`, so
     * the next free channel is one past the furthest byte any *other* driven
     * parameter reaches. Assigned when a parameter is switched to DMX, so a
     * 16-bit dimmer at channel 1 leaves the next tick landing on channel 3
     * rather than colliding on channel 2.
     *
     * @public
     * @param {String} exceptKey the parameter being placed, left out of the sum
     * @returns {Number}
     */
    nextFreeChannel(exceptKey) {
      let end = 0;
      LASER_CHANNEL_ORDER.forEach((key) => {
        if (key === exceptKey) return;
        const control = this.laserControls[key];
        if (CONTROL_MODES[control.modeIndex] !== 'dmx') return;
        const channel = Math.max(1, Math.round(control.channel) || 1);
        const bytes = (CONTROL_BITS[control.bitsIndex] || 8) / 8;
        end = Math.max(end, channel - 1 + bytes);
      });
      return end + 1;
    },
    /**
     * Changes a parameter's mode, and when it becomes DMX drops it on the next
     * free channel so a fresh tick never lands on a byte already in use.
     *
     * @public
     * @param {String} key
     * @param {Number} index into `CONTROL_MODES`
     */
    setControlMode(key, index) {
      this.laserControls[key].modeIndex = index;
      if (CONTROL_MODES[index] === 'dmx') {
        this.laserControls[key].channel = this.nextFreeChannel(key);
      }
    },
    /**
     * A ratio in the terms people say out loud, when it is one of those.
     *
     * Reduced by the greatest common divisor and then named if the result is
     * one of the handful anyone recognises -- 1918 x 1080 is not 16:9 and
     * should not claim to be, but nor is "959:540" any use to a reader.
     *
     * @public
     * @param {Number} wide
     * @param {Number} high
     * @returns {String}
     */
    aspectName(wide, high) {
      if (!wide || !high) return '';
      const gcd = (a, b) => (b ? gcd(b, a % b) : a);
      const d = gcd(wide, high);
      const w = wide / d;
      const h = high / d;
      if (w <= 64 && h <= 64) return `${w}:${h}`;
      return `${(wide / high).toFixed(2)}:1`;
    },
    /**
     * The name this dialog would offer for a kind.
     *
     * The same answer `freeName` gives, which numbers past anything already in
     * the library -- so after making a "LED Bar" the suggestion becomes
     * "LED Bar 2", and a field still holding that still counts as unnamed.
     *
     * @public
     * @param {Number} index into `KIND_NAMES`
     * @returns {String}
     */
    suggestionFor(index) {
      return this.freeName(KIND_NAMES[index] || KIND_NAMES[0]);
    },
    /**
     * A name, or the nearest free numbering of it.
     *
     * @public
     * @param {String} [from] the name to start from; the current one by default
     * @returns {String} a name no profile of this manufacturer is using
     */
    freeName(from = this.model) {
      const maker = this.manufacturer.trim();
      const wanted = (from || '').trim() || KIND_NAMES[0];
      const taken = (name) => !!this.$show.generatedProfiles[`${maker}/${name}`];
      if (!taken(wanted)) return wanted;
      // A trailing number is stripped first, so opening the dialog five times
      // gives "LED Bar 5" rather than "LED Bar 2 2 2 2".
      const base = wanted.replace(/\s+\d+$/, '');
      let n = 2;
      while (taken(`${base} ${n}`)) n += 1;
      return `${base} ${n}`;
    },
    /**
     * Builds the profile and hands it to the show, which owns the library.
     *
     * @public
     */
    async create() {
      // Closed before the profile is written, not after. Writing it makes the
      // name in these very fields taken, so the duplicate warning appeared for
      // the thing being created -- a red line and a jump as the dialog grew,
      // in the instant before it went away.
      this.state = false;
      if (this.builder === GENERIC_KINDS.DISPLAY) {
        const made = await this.$show.createGeneratedProfile(
          this.manufacturer.trim(),
          this.model.trim(),
          this.displayParams,
          this.builder,
        );
        this.$emit('created', made);
        return;
      }
      if (this.isLaser) {
        const made = await this.$show.createGeneratedProfile(
          this.manufacturer.trim(),
          this.model.trim(),
          this.laserParams,
          this.builder,
        );
        this.$emit('created', made);
        return;
      }
      if (!this.isBar) {
        const made = await this.$show.createGeneratedProfile(
          this.manufacturer.trim(),
          this.model.trim(),
          this.projectorParams,
          this.builder,
        );
        this.$emit('created', made);
        return;
      }
      const key = await this.$show.createGeneratedProfile(
        this.manufacturer.trim(),
        this.model.trim(),
        {
          length: this.length / MM,
          width: this.width / MM,
          height: this.height / MM,
          marginEnds: this.marginEnds / MM,
          marginSides: this.marginSides / MM,
          columns: this.columns,
          rows: this.rows,
          emitterSize: this.emitterSize / MM,
          beamAngle: this.beamAngle,
          order: this.order,
          startCorner: this.startCorner,
          scanAxis: this.scanAxis,
          serpentine: this.serpentine,
          universeAligned: this.universeAligned,
          shape: this.shape,
        },
        this.builder,
      );
      // `state` is a computed over the parent's v-model, and its setter above
      // is what announces the change -- this dialog has no popup mixin and so
      // no close(). Calling one threw after the profile had been written,
      // leaving the dialog open holding the name it had just taken.
      this.$emit('created', key);
    },
  },
};
</script>

<style scoped>
.create_form {
  padding: 12px;
  min-width: 560px;
}
.create_section {
  font-family: Roboto-Medium;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--secondary-lighter-alt);
  border-bottom: 1px solid var(--primary-dark);
  padding-bottom: 4px;
}
/* The one line someone building a rig reads off this form: what to feed it.
   Sized up from the summaries below it because it answers a different kind of
   question -- those describe the panel, this says what it wants. */
.create_headline {
  font-family: Roboto-Medium;
  font-size: 13px;
  color: var(--secondary-lighter);
  margin: 0;
}
.create_summary {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter-alt);
  margin: 0;
}
.create_warning {
  font-family: Roboto-Medium;
  font-size: 11px;
  color: var(--accent-maroon);
  margin: 0;
}
.field {
  width: 90px;
}
/* Lumens and a contrast ratio run to five and seven digits, which will not sit
   in the 90px a millimetre needs. */
.wide_field {
  width: 120px;
}
.ticks {
  flex-wrap: wrap;
}
/* One output-stage parameter: label, mode, then either a value or the DMX
   channel and depth. Bottom-aligned so the labelled inputs line up. */
.control_row {
  align-items: flex-end;
  margin-bottom: 4px;
}
.control_label {
  width: 96px;
  align-self: center;
  /* global.css sets no font on body, so a bare span falls through to the
     browser default -- a black serif. Name the family and colour, as every
     other label here does. */
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter-alt);
}
.preview {
  width: 100%;
  height: 150px;
  background: var(--primary-dark-alt);
  border: 1px solid var(--primary-dark);
}
.preview_body {
  fill: var(--primary-lighter);
  stroke: var(--secondary-light-alt);
  stroke-width: 1;
}
/* The one thing that has to read at a glance, so it is the one thing with a
   colour. Everything else is the box it sits on. */
.preview_lens {
  fill: var(--accent-teal);
  stroke: none;
}
.preview_datum {
  stroke: var(--secondary-light);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.preview_label {
  font-family: Roboto-Medium, sans-serif;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  fill: var(--secondary-lighter-alt);
}
</style>
