<template>
  <uk-widget
    class="measure_widget"
    dockable
    :header="header"
  >
    <uk-flex
      col
      :gap="6"
      class="measure_body"
    >
      <uk-flex :gap="4">
        <uk-button
          v-for="option in modes"
          :key="option.id"
          :label="option.label"
          :model-value="measure.active && measure.mode === option.id"
          toggleable
          color="var(--accent-blue)"
          @click="choose(option.id)"
        />
      </uk-flex>

      <p class="measure_hint">
        {{ hint }}
      </p>
      <p
        v-if="measure.message"
        class="measure_message"
      >
        {{ measure.message }}
      </p>

      <div class="measure_list">
        <div
          v-for="m in measure.measurements"
          :key="m.id"
          class="measure_row"
          :class="{ lit: m.id === measure.selectedId, hidden: m.hidden }"
          :data-measure-id="m.id"
          @mouseenter="hover(m.id)"
          @mouseleave="hover(null)"
          @click="select(m.id)"
        >
          <div class="measure_row_head">
            <span class="measure_number">{{ m.number }}</span>
            <span class="measure_headline">{{ m.headline }}</span>
            <!-- What the label in the view says: one cluster, teal when on. -->
            <div class="label_cluster">
              <button
                type="button"
                class="label_toggle"
                :class="{ on: m.showLength }"
                :title="`${m.showLength ? 'Hide' : 'Show'} the length in the label`"
                @click.stop="setLabel(m, { showLength: !m.showLength })"
              >
                <uk-icon name="ruler" />
              </button>
              <button
                type="button"
                class="label_toggle"
                :class="{ on: m.showAngle }"
                :title="`${m.showAngle ? 'Hide' : 'Show'} the angle in the label`"
                @click.stop="setLabel(m, { showAngle: !m.showAngle })"
              >
                <uk-icon name="angle" />
              </button>
              <button
                type="button"
                class="label_toggle"
                :class="{ on: m.flipAngle }"
                title="Flip the angle to the other side"
                @click.stop="setLabel(m, { flipAngle: !m.flipAngle })"
              >
                <uk-icon name="flip_x" />
              </button>
            </div>
            <span class="measure_tool_gap" />
            <uk-button
              :key="`hide-${m.id}-${m.hidden}`"
              icon="hide"
              icon-only
              flat
              toggleable
              :value="false"
              :model-value="m.hidden"
              color="var(--accent-blue)"
              :title="m.hidden ? 'Show' : 'Hide'"
              @click="setHidden(m)"
            />
            <uk-button
              icon="copy"
              icon-only
              flat
              title="Copy"
              @click="copy(m)"
            />
            <uk-button
              icon="trash"
              icon-only
              flat
              title="Delete"
              @click="remove(m.id)"
            />
          </div>
          <div
            v-for="[label, text] in details(m)"
            :key="label"
            class="measure_value"
          >
            <span>{{ label }}</span><span>{{ text }}</span>
          </div>
          <div class="measure_ends">
            {{ m.ends.map((end) => end.label).join(' → ') }}
          </div>
        </div>
      </div>

      <uk-flex
        :gap="8"
        class="measure_actions"
      >
        <uk-button
          label="clear all"
          :disabled="!measure.measurements.length"
          @click="clear"
        />
        <uk-button
          :label="measure.active ? 'stop measuring' : 'measure'"
          @click="toggle"
        />
      </uk-flex>
    </uk-flex>
  </uk-widget>
</template>

<script>
import MeasureTool, {
  MEASURE_MODES, detailsOf, textOf,
} from '@/plugins/visualizer/measure_tool';

export default {
  name: 'MeasureWidget',
  compatConfig: {
    MODE: 3,
  },
  data() {
    return {
      measure: MeasureTool.state,
      header: { title: 'Measure', icon: 'ruler' },
      modes: [
        { id: MEASURE_MODES.DISTANCE, label: 'distance' },
        { id: MEASURE_MODES.ANGLE, label: 'angle' },
        { id: MEASURE_MODES.THROW, label: 'throw' },
      ],
    };
  },
  computed: {
    /**
     * What the next click does.
     *
     * @returns {String}
     */
    hint() {
      const { active, mode, pending } = this.measure;
      if (!active) return 'Measuring is off. Press M or choose a mode to start.';
      if (mode === MEASURE_MODES.THROW) {
        return 'Click a fixture: its throw is measured from the lens along the beam to the first surface.';
      }
      if (mode === MEASURE_MODES.ANGLE) {
        return ['Click the first arm.', 'Click the corner.', 'Click the second arm.'][pending.length];
      }
      return pending.length
        ? 'Click the second point. On an axis, hold Shift to lock it; or the arrow keys: right x, left y, up z.'
        : 'Click the first point. Hold Ctrl to place it without snapping.';
    },
  },
  watch: {
    /** The selected measurement's row is brought into view. */
    'measure.selectedId': {
      immediate: true,
      handler(id) {
        if (id === null) return;
        this.$nextTick(() => {
          const row = this.$el && this.$el.querySelector
            && this.$el.querySelector(`[data-measure-id="${id}"]`);
          if (row) row.scrollIntoView({ block: 'nearest' });
        });
      },
    },
  },
  methods: {
    details(measurement) {
      return detailsOf(measurement);
    },
    choose(mode) {
      MeasureTool.setMode(mode);
      MeasureTool.toggle(true);
    },
    toggle() {
      MeasureTool.toggle();
    },
    select(id) {
      MeasureTool.select(id);
    },
    hover(id) {
      MeasureTool.hoverRow(id);
    },
    remove(id) {
      MeasureTool.remove(id);
    },
    setHidden(measurement) {
      MeasureTool.setHidden(measurement.id, !measurement.hidden);
    },
    setLabel(measurement, settings) {
      MeasureTool.setLabel(measurement.id, settings);
    },
    clear() {
      MeasureTool.clear();
    },
    /**
     * Puts one measurement on the clipboard as a line of text.
     *
     * @param {Object} measurement
     */
    copy(measurement) {
      if (navigator.clipboard) navigator.clipboard.writeText(textOf(measurement));
    },
  },
};
</script>

<style scoped>
.measure_body {
  height: 100%;
  width: 100%;
  padding: 8px;
  white-space: normal;
  overflow-y: auto;
}
.measure_body > * {
  flex-shrink: 0;
}
.measure_hint,
.measure_message {
  font-family: Roboto-Regular;
  font-size: 11px;
  line-height: 1.45;
  margin: 0;
  width: 0;
  min-width: 100%;
  color: var(--secondary-lighter-alt);
}
.measure_message {
  color: var(--accent-orange, #d08b3c);
}
.measure_list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 0;
  min-height: 60px;
  overflow-y: auto;
}
.measure_row {
  padding: 4px 6px;
  border-left: 2px solid transparent;
  background: var(--primary-dark);
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-lighter);
  cursor: default;
}
.measure_row:hover {
  background: var(--primary-light, #2a2a2e);
}
.measure_row.lit {
  border-left-color: #1ca6bd;
}
.measure_row.hidden {
  opacity: 0.5;
}
.measure_row_head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.measure_number {
  opacity: 0.6;
  min-width: 14px;
}
.measure_headline {
  flex: 1;
  font-family: Roboto-medium;
  color: #fff;
}
/* Separates the label toggles from the row's own actions. */
.measure_tool_gap {
  width: 6px;
}
.label_cluster {
  display: flex;
  gap: 1px;
}
.label_toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  background: var(--primary-light, #2a2a2e);
  cursor: pointer;
}
.label_toggle:hover {
  background: var(--primary-lighter);
}
.label_toggle.on {
  background: var(--accent-blue);
}
.label_toggle :deep(svg) {
  width: 14px;
  height: 14px;
  fill: var(--secondary-light-alt);
}
.label_toggle.on :deep(svg) {
  fill: #fff;
}
.measure_value {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding-left: 20px;
  font-variant-numeric: tabular-nums;
}
.measure_value span:first-child {
  color: var(--secondary-lighter-alt);
}
.measure_ends {
  padding-left: 20px;
  color: var(--secondary-lighter-alt);
  overflow-wrap: anywhere;
}
.measure_actions {
  align-items: center;
}
</style>
