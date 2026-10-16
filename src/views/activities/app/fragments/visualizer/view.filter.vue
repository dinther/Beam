<template>
  <div
    ref="root"
    class="view_filter"
  >
    <!-- Keyed by state: lit while anything is left out, not after a click. -->
    <uk-button
      :key="`view-filter-${filtering}`"
      icon="funnel"
      icon-only
      square
      toggleable
      :value="false"
      :model-value="filtering"
      color="var(--accent-blue)"
      :label="filtering ? 'View filter: some items hidden' : 'View filter'"
      @click="toggleOpen"
    />
    <teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="view_filter_panel"
        :style="panelStyle"
      >
        <div
          v-for="group in groups"
          :key="group.id"
          class="view_filter_group"
        >
          <h4 class="view_filter_title">
            {{ group.title }}
          </h4>
          <div
            v-for="option in group.options"
            :key="option.id"
            class="view_filter_option"
            @click="option.set(!option.on)"
          >
            <span @click.stop>
              <uk-checkbox
                :model-value="option.on"
                @update:model-value="option.set"
              />
            </span>
            <span class="view_filter_label">{{ option.label }}</span>
            <span class="view_filter_count">{{ option.count }}</span>
          </div>
        </div>
        <div
          class="view_filter_clear"
          :class="{ disabled: !filtering }"
          @click="showAll"
        >
          Show all
        </div>
      </div>
    </teleport>
  </div>
</template>

<script>
import ViewFilter, { MEASURE_FILTERS } from '@/models/DMX/view_filter';
import MeasureTool from '@/plugins/visualizer/measure_tool';
import { typeName } from '@/models/DMX/patch_sheet';

/**
 * The viewport's view filter: objects, structures and fixture types shown or
 * left out, and which measurements are drawn with the ruler off. A ticked box
 * is shown. Hidden items keep their own hide flags; see `view_filter.js`.
 */
export default {
  name: 'ViewFilter',
  compatConfig: {
    MODE: 3,
  },
  data() {
    return {
      filter: ViewFilter.state,
      measure: MeasureTool.state,
      open: false,
      panelStyle: {},
    };
  },
  computed: {
    filtering() {
      const f = this.filter;
      return !f.objects || !f.structures || f.hiddenTypes.length > 0
        || f.measurements !== MEASURE_FILTERS.ALL;
    },
    /** `[{ id, title, options: [{ id, label, count, on, set }] }]` */
    groups() {
      const show = this.$show;
      const f = this.filter;
      const types = new Map();
      show.fixturePool.fixtures.forEach((fixture) => {
        const key = fixture.profileKey;
        if (!types.has(key)) types.set(key, { label: typeName(fixture), count: 0 });
        types.get(key).count += 1;
      });
      // A type left out whose fixtures have all gone stays listed, so it can
      // be shown again.
      f.hiddenTypes.forEach((key) => {
        if (!types.has(key)) types.set(key, { label: key.replace('/', ' '), count: 0 });
      });
      const measurement = (mode, label) => ({
        id: mode,
        label,
        count: '',
        on: f.measurements === mode,
        set: () => ViewFilter.setMeasurements(mode),
      });
      return [
        {
          id: 'scene',
          title: 'Scene',
          options: [
            {
              id: 'objects',
              label: 'Objects',
              count: show.objects.length,
              on: f.objects,
              set: (on) => ViewFilter.setShown('objects', on),
            },
            {
              id: 'structures',
              label: 'Structures',
              count: show.structures.length,
              on: f.structures,
              set: (on) => ViewFilter.setShown('structures', on),
            },
          ],
        },
        {
          id: 'types',
          title: 'Fixture types',
          options: [...types.entries()]
            .sort((a, b) => a[1].label.localeCompare(b[1].label))
            .map(([key, type]) => ({
              id: key,
              label: type.label,
              count: type.count,
              on: !f.hiddenTypes.includes(key),
              set: (on) => ViewFilter.setTypeShown(key, on),
            })),
        },
        {
          id: 'measurements',
          title: `Measurements with the ruler off (${this.measure.measurements.length})`,
          options: [
            measurement(MEASURE_FILTERS.ALL, 'All'),
            measurement(MEASURE_FILTERS.SELECTION, 'On the selection'),
            measurement(MEASURE_FILTERS.NONE, 'None'),
          ],
        },
      ].filter((group) => group.options.length);
    },
  },
  beforeUnmount() {
    this.listen(false);
  },
  methods: {
    showAll() {
      ViewFilter.showAll();
    },
    /** Opens below the button, its left edge on the button's. */
    toggleOpen() {
      this.open = !this.open;
      if (this.open) {
        const r = this.$refs.root.getBoundingClientRect();
        this.panelStyle = { top: `${r.bottom + 4}px`, left: `${r.left}px` };
      }
      this.listen(this.open);
    },
    listen(on) {
      const method = on ? 'addEventListener' : 'removeEventListener';
      document[method]('mousedown', this.closeOutside, true);
      document[method]('keydown', this.closeOnEscape, true);
    },
    closeOutside(e) {
      const inside = [this.$refs.root, this.$refs.panel].some((el) => el && el.contains(e.target));
      if (!inside) this.close();
    },
    closeOnEscape(e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      this.close();
    },
    close() {
      this.open = false;
      this.listen(false);
    },
  },
};
</script>

<style scoped>
.view_filter {
  position: relative;
  display: flex;
}
/* Opaque and square-cornered: text over a translucent or rounded layer
   loses its subpixel antialiasing. */
.view_filter_panel {
  position: fixed;
  z-index: 250;
  min-width: 220px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 6px 0;
  background: var(--primary-light);
  border: 1px solid var(--secondary-darker);
}
.view_filter_group + .view_filter_group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--primary-dark);
}
.view_filter_title {
  padding: 2px 10px 4px;
  font-family: Roboto-Bold;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.view_filter_option {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 22px;
  padding: 0 10px;
  cursor: pointer;
}
.view_filter_option:hover {
  background: var(--primary-lighter);
}
.view_filter_label {
  flex: 1;
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter);
}
.view_filter_count {
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.view_filter_clear {
  margin-top: 6px;
  padding: 6px 10px 2px;
  border-top: 1px solid var(--primary-dark);
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--secondary-lighter);
  cursor: pointer;
}
.view_filter_clear.disabled {
  color: var(--secondary-light);
  cursor: default;
}
</style>
