<template>
  <uk-flex
    col
    class="object_browser"
  >
    <h4
      v-if="!groups.length"
      class="object_browser_empty"
    >
      No objects yet
    </h4>

    <!-- The scroller is inside, not the root. The root wears `fixture_list`
         from the dialog, which fixes the height and sets `overflow: hidden`,
         so anything scrollable has to be a child of it. -->
    <div
      v-if="groups.length"
      class="object_browser_scroll"
    >
      <div
        v-for="group in groups"
        :key="group.name"
        class="object_browser_group"
      >
        <button
          type="button"
          class="object_browser_folder"
          @click="toggle(group.name)"
        >
          <uk-icon
            class="object_browser_chevron"
            :class="{ open: isOpen(group.name) }"
            name="arrow_down"
          />
          <uk-icon
            class="object_browser_folder_icon"
            :name="group.folder ? 'folder' : 'object'"
          />
          <span class="object_browser_folder_name">{{ group.name }}</span>
          <span class="object_browser_count">{{ group.models.length }}</span>
        </button>

        <div
          v-if="isOpen(group.name)"
          class="object_browser_grid"
        >
          <button
            v-for="model in group.models"
            :key="model.key"
            type="button"
            class="object_browser_tile"
            :class="{ selected: selectedKey === model.key }"
            :title="tooltip(model)"
            @click="$emit('select', model)"
            @dblclick="$emit('confirm', model)"
          >
            <span class="object_browser_thumb">
              <img
                v-if="thumbnail(model)"
                :src="thumbnail(model)"
                :alt="model.name"
              >
              <uk-icon
                v-else
                name="object"
                class="object_browser_placeholder"
              />
            </span>
            <span class="object_browser_name">{{ model.name }}</span>
          </button>
        </div>
      </div>
    </div>
  </uk-flex>
</template>

<script>
/**
 * @file Browses the object library as folders of square tiles.
 *
 * A list of names says very little about a shape, so objects get pictures and
 * pictures want a grid. Deliberately its own component rather than a mode of
 * `uk-list`: that component serves every other tab in the app, and a grid is a
 * different thing from a row -- teaching it both would put the risk on
 * everything rather than on this.
 *
 * A thumbnail is `<name>.png` beside the model, the same convention the
 * metadata sidecar follows. Anything without one falls back to the object
 * icon, so the browser is useful before a single picture exists.
 */

/** Objects that live in no folder, gathered under one heading. */
const UNSORTED = 'Unsorted';

export default {
  name: 'ObjectBrowser',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** Library entries from `window.library.objects()`. */
    models: {
      type: Array,
      default: () => [],
    },
    /** The key of the selected model, or null. */
    selectedKey: {
      type: String,
      default: null,
    },
  },
  emits: ['select', 'confirm'],
  data() {
    return {
      /** Folders the user has opened. Names, not indices. */
      opened: [],
      /** Whether anything has been opened yet, so the first can open itself. */
      touched: false,
    };
  },
  computed: {
    /**
     * The models grouped by folder, folders first and loose objects last.
     *
     * Same order the list used: the unfoldered ones are the least likely to be
     * what is being looked for, since they are the ones nobody has filed.
     *
     * @returns {Array}
     */
    groups() {
      const byFolder = new Map();
      const loose = [];
      this.models.forEach((model) => {
        if (!model.folder) {
          loose.push(model);
          return;
        }
        if (!byFolder.has(model.folder)) byFolder.set(model.folder, []);
        byFolder.get(model.folder).push(model);
      });

      const folders = [...byFolder.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, models]) => ({ name, folder: true, models }));

      if (!loose.length) return folders;
      // With nothing filed, the objects are the whole catalogue and a single
      // heading over all of them says nothing -- so they stand on their own.
      if (!folders.length) return [{ name: UNSORTED, folder: false, models: loose }];
      return [...folders, { name: UNSORTED, folder: false, models: loose }];
    },
  },
  watch: {
    groups: {
      immediate: true,
      handler(groups) {
        // The first folder opens itself, so the panel is never a column of
        // closed headings with nothing to look at.
        if (this.touched || !groups.length) return;
        this.opened = [groups[0].name];
      },
    },
  },
  methods: {
    isOpen(name) {
      return this.opened.includes(name);
    },
    /**
     * Opens or closes a folder.
     *
     * @param {String} name
     */
    toggle(name) {
      this.touched = true;
      this.opened = this.isOpen(name)
        ? this.opened.filter((entry) => entry !== name)
        : [...this.opened, name];
    },
    /**
     * Where a model's preview image can be fetched from, if it has one.
     *
     * A user model's is served over `library://`; a shipped one is a static
     * asset, and the prefix for those is a renderer concern -- which is why
     * main hands over a path rather than a finished url.
     *
     * @param {Object} model
     * @returns {String|null}
     */
    thumbnail(model) {
      if (model.thumbnailUrl) return model.thumbnailUrl;
      if (model.thumbnailStaticPath) {
        return `${import.meta.env.VITE_STATIC_URL}/${model.thumbnailStaticPath}`;
      }
      return null;
    },
    /**
     * What the tile says on hover: the things a name cannot.
     *
     * @param {Object} model
     * @returns {String}
     */
    tooltip(model) {
      const parts = [model.key];
      if (model.kind === 'primitive') {
        parts.push('created');
      } else {
        parts.push(model.described
          ? `${model.scale}x ${String(model.upAxis).toUpperCase()}-up`
          : 'not imported');
      }
      if (model.shipped) parts.push('supplied');
      return parts.join(' · ');
    },
  },
};
</script>

<style scoped>
/*
 * Matched to `uikit.list.item.vue` rather than invented: rows sit on
 * --primary-light, hover is --secondary-darker, and a selection is the teal at
 * 16% with the solid --accent-teal reserved for the focused one. A browser that
 * styles itself differently from the list beside it reads as a different app.
 */
.object_browser {
  width: 100%;
  height: 100%;
  gap: 0;
  background: var(--primary-light);
  /* The root cannot be the scroller: it wears `fixture_list` from the dialog,
     which sets a fixed height and `overflow: hidden`. */
  overflow: hidden;
}

/* `min-height: 0` is the whole trick. A flex child will not shrink below its
   content without it, so `overflow-y: auto` has nothing to scroll and the
   grid simply overflows the panel. */
.object_browser_scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  width: 100%;
}

.object_browser_empty {
  opacity: 0.6;
  padding: 12px;
}

.object_browser_folder {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: none;
  border-bottom: 1px solid var(--primary-dark);
  background: var(--primary-light);
  color: var(--secondary-lighter);
  font-family: Roboto-bold;
  font-size: 13px;
  text-align: left;
  opacity: 0.9;
  transition: background-color 0.1s;
  cursor: pointer;
}

.object_browser_folder:hover {
  background: var(--secondary-darker);
}

/* One asset rotated, the file-explorer convention the list already follows:
   pointing right when closed, down when open. */
.object_browser_chevron {
  width: 12px;
  height: 12px;
  transform: rotate(-90deg);
  transition: transform 120ms ease;
}

.object_browser_chevron.open {
  transform: rotate(0deg);
}

@media (prefers-reduced-motion: reduce) {
  .object_browser_chevron { transition: none; }
}

.object_browser_folder_icon {
  width: 16px;
  height: 16px;
}

.object_browser_folder_name {
  flex: 1;
}

.object_browser_count {
  color: var(--secondary-light-alt);
  font-family: Roboto-medium;
  font-size: 11px;
}

/* Square tiles that reflow: the dialog is resizable and a fixed column count
   would either waste the width or clip. */
.object_browser_grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: 8px;
  padding: 10px 10px 14px;
  background: var(--primary-dark-alt);
  border-bottom: 1px solid var(--primary-dark);
}

.object_browser_tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: var(--secondary-lighter-alt);
  font-family: Roboto-medium;
  transition: background-color 0.1s;
  cursor: pointer;
}

.object_browser_tile:hover {
  background: var(--secondary-darker);
}

.object_browser_tile.selected {
  background: rgba(28, 166, 189, 0.16);
  border-color: var(--accent-teal);
  color: var(--secondary-lighter);
}

/* `aspect-ratio` keeps the well square whatever the column width, so the grid
   reflows without the tiles distorting. */
.object_browser_thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  border: 1px solid var(--primary-dark);
  border-radius: 2px;
  background: var(--primary-dark);
  overflow: hidden;
}

.object_browser_thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.object_browser_placeholder {
  width: 30px;
  height: 30px;
  opacity: 0.3;
}

.object_browser_name {
  font-size: 11px;
  line-height: 1.25;
  text-align: center;
  /* Two lines, then ellipsis: a tile that grows with its name breaks the grid. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
</style>
