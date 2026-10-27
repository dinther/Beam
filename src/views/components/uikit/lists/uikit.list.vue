<template>
  <div class="uikit_list">
    <!-- The owner's filter buttons sit after the search box, on its line. -->
    <div
      v-if="filterable"
      class="uikit_list_search"
    >
      <uk-txt-input
        v-model="searchString"
        :disabled="disabled"
        :outlined="false"
        auto-update
        class="uikit_list_searchbox"
        :placeholder="'Search items'"
      />
      <slot name="filters" />
    </div>
    <!-- `band`: a margin round the rows and room below them, where a press
         starts a band selection rather than landing on a row. -->
    <div
      v-if="rows.length"
      ref="body"
      tabindex="0"
      class="uikit_list_body"
      :class="{ band: bandSelect && !noHighlight }"
      @focus="handleFocusIn"
      @focusout="handleFocusOut"
      @dragleave="dragLeave"
      @mousedown="startBand"
    >
      <!-- Stretching an unfolded item to share the container's height is what
           accordion mode is, so it follows that flag. Without it a group takes
           only the room its own items need and the slack gathers at the bottom,
           rather than being dealt out equally between the groups. -->
      <div
        v-for="(row, index) in rows"
        :key="row.key"
        class="uikit_list_item parent"
        :class="{
          drop_before: dropIndex === index,
          drop_after: dropIndex === rows.length && index === rows.length - 1,
          separated: !!(row.value && row.value.separatorBefore),
        }"
        :style="{
          flex: isOpen(row) && accordion ? 1 : 'unset',
          overflowY: isOpen(row) && row.children && accordion ? 'hidden' : 'visible',
        }"
        @dragover.prevent="(e) => dragOver(e, index)"
        @drop.prevent="drop"
      >
        <div
          v-if="row.children"
          class="uikit_list_item_unfoldable"
        >
          <uk-list-item
            :value="row.value"
            :data-band-key="bandKey(row)"
            :selected="isSelected(row)"
            :highlighted="isHighlighted(row)"
            :unfolded="isOpen(row)"
            :colored="colored"
            :focused="hasFocus"
            :tall="tall"
            :no-select="noSelect"
            :draggable="draggable"
            @dragstart="(e) => startDrag(e, row)"
            @dragend.prevent="stopDrag"
            @click="(e) => clickRow(e, row, rows)"
            @dblclick="activate(row)"
            @unfold="unfold(row)"
          />
          <Transition name="fadeHeight">
            <span
              v-if="isOpen(row) && row.children.length"
              :style="{ overflowY: 'auto' }"
            >
              <uk-list-item
                v-for="child in row.children"
                :key="child.key"
                class="uikit_sublist_body"
                :value="child.value"
                :data-band-key="bandKey(child)"
                :selected="isSelected(child)"
                :highlighted="isHighlighted(child)"
                :no-highlight="noHighlight"
                :focused="hasFocus"
                :tall="tall"
                :no-select="noSelect"
                :draggable="draggable"
                @dragstart="(e) => startDrag(e, child)"
                @dragend.prevent="stopDrag"
                @click="(e) => clickRow(e, child, row.children)"
                @dblclick="activate(child)"
              />
            </span>
          </Transition>
          <div
            v-if="isOpen(row) && !row.children.length"
            class="uikit_list_body_empty"
          >
            <h3>Nothing to display</h3>
          </div>
        </div>
        <uk-list-item
          v-else
          :value="row.value"
          :data-band-key="bandKey(row)"
          :selected="isSelected(row)"
          :highlighted="isHighlighted(row)"
          :colored="colored"
          :focused="hasFocus"
          :tall="tall"
          :no-select="noSelect"
          :draggable="draggable"
          @dragstart="(e) => startDrag(e, row)"
          @dragend.prevent="stopDrag"
          @click="(e) => clickRow(e, row, rows)"
          @dblclick="activate(row)"
        />
        <div class="uikit_sublist_body_empty" />
      </div>
    </div>
    <div
      v-else
      class="uikit_list_body_empty"
    >
      <h3>Nothing to display</h3>
    </div>
  </div>
</template>
<script>
import { searchWords, matchesWords } from '@/plugins/word_search';

/**
 * A row's key: the id its owner gave it, or its name where it has none. A
 * child without an id is keyed under its parent, so two folders can each hold
 * an entry of the same name.
 *
 * @param {Object} value the row's item
 * @param {*} [parentKey] the parent row's key, for a child
 * @returns {String|Number}
 */
function keyOf(value, parentKey) {
  if (value && value.id !== undefined && value.id !== null) return value.id;
  const name = value ? value.name : '';
  return parentKey === undefined ? `/${name}` : `${parentKey}/${name}`;
}

/**
 * A list of items, one level of which may unfold.
 *
 * The rows are worked out from `items` and never written back: which rows are
 * selected, highlighted and open is held as keys, and a row is drawn from
 * whether its key is among them. Rebuilding the rows therefore cannot leave a
 * mark on the wrong one.
 *
 * Selection belongs to the owner when it passes `highlightIds` or
 * `selectedId`, and the list only reports clicks; otherwise the list keeps the
 * same keys itself.
 */
export default {
  name: 'UkList',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /**
     * Whether a click anywhere on a row with children opens or closes it,
     * rather than selecting it. For lists whose folders are only containers,
     * where selecting one would do nothing.
     */
    openFolders: {
      type: Boolean,
      default: false,
    },
    /**
     * Whether a press beside or below the rows starts a band selection: every
     * row the drag passes over is highlighted as it goes. Ctrl or Shift adds
     * to what is already highlighted.
     */
    bandSelect: {
      type: Boolean,
      default: false,
    },
    /** Whether the list is disabled */
    disabled: Boolean,
    /** Whether the Delete key reports the selection for deletion */
    deletable: Boolean,
    /**
     * Whether a search box filters the rows by name: every word, in any
     * order. A row with `unfiltered` set is shown as given whatever the search.
     */
    filterable: Boolean,
    /** The search box's text, when the owner wants to read or set it (`v-model:search`). */
    search: {
      type: String,
      default: undefined,
    },
    /** Whether rows may be dragged to a new place in the list */
    draggable: Boolean,
    /**
     * Ids of the rows to show as highlighted, when the owner holds the
     * selection. Null leaves the list to keep its own.
     */
    highlightIds: {
      type: Array,
      default: null,
    },
    /**
     * Id of the row to show as selected, when the owner holds the selection.
     * Undefined leaves the list to keep its own; null means none.
     */
    selectedId: {
      type: [String, Number],
      default: undefined,
    },
    /** Whether several rows can be highlighted at once */
    noHighlight: Boolean,
    /** Whether the selected row is drawn as selected */
    noSelect: Boolean,
    /** `{ id?, name, unfold?, ... }` per row; `unfold` holds child rows */
    items: {
      type: Array,
      default: () => [],
    },
    /** Coloured dot styling */
    colored: Boolean,
    /** Tall (40px) rows */
    tall: Boolean,
    /** Selects, or opens, the first row once there is one */
    autoSelectFirst: Boolean,
    /** Selects the row at this index */
    autoSelect: {
      type: Number,
      default: null,
    },
    /** Only one row open at a time, sharing the height between open rows */
    accordion: Boolean,
  },
  emits: ['unfold', 'focused', 'highlight', 'select', 'reorder', 'delete', 'update:search', 'activate'],
  data() {
    return {
      /** The search box's text. */
      searchString: this.search || '',
      /** Highlighted keys, when the owner does not hold them. */
      ownHighlight: [],
      /** Selected key, when the owner does not hold it. */
      ownSelected: null,
      /** The row a shift-click ranges from, when nothing is selected. */
      anchorKey: null,
      /** Keys of the rows showing their children. */
      openKeys: [],
      /** Whether the list has keyboard focus. */
      hasFocus: false,
      /** Whether a drag is under way. */
      dragging: false,
      /** Key of the row being dragged. */
      draggedKey: null,
      /**
       * Gap the dragged item would land in: 0 is above the first row, the
       * row count is below the last. Null when the drop would change nothing.
       */
      dropIndex: null,
      /**
       * A band selection under way: where it started, in the body's scrolled
       * coordinates, the keys it adds to, and where the pointer is. Null when
       * there is none.
       */
      band: null,
    };
  },
  computed: {
    /**
     * Every row, children included, unfiltered.
     *
     * @returns {Array<Object>} `{ key, value, children }`, children null for a
     *   row that does not unfold
     */
    allRows() {
      return (this.items || []).map((value) => {
        const key = keyOf(value);
        const children = Array.isArray(value.unfold)
          ? value.unfold.map((child) => ({ key: keyOf(child, key), value: child, children: null }))
          : null;
        return { key, value, children };
      });
    },
    /**
     * Rows by key, children included, whatever the search is hiding.
     *
     * @returns {Map}
     */
    rowsByKey() {
      const byKey = new Map();
      this.allRows.forEach((row) => {
        byKey.set(row.key, row);
        (row.children || []).forEach((child) => byKey.set(child.key, child));
      });
      return byKey;
    },
    /**
     * The rows the search leaves. A folder with a matching child shows only
     * those children, and shows them open.
     *
     * @returns {Array<Object>} `{ key, value, children, opened? }`
     */
    rows() {
      const words = searchWords(this.searchString);
      if (!words.length) return this.allRows;
      return this.allRows.flatMap((row) => {
        // A row that answers the search itself, already narrowed by its owner.
        if (row.value.unfiltered) return [{ ...row, opened: true }];
        // A folder matched by its own name shows whole, as it is.
        if (matchesWords(words, row.value.name)) return [row];
        if (row.children) {
          // A child is read with its folder's name, so "maker model" finds a
          // model filed under its maker.
          const found = row.children
            .filter((child) => matchesWords(words, row.value.name, child.value.name));
          if (found.length) return [{ ...row, children: found, opened: true }];
        }
        return [];
      });
    },
    /** @returns {Set} highlighted keys, the owner's or the list's own */
    highlightSet() {
      return new Set(Array.isArray(this.highlightIds) ? this.highlightIds : this.ownHighlight);
    },
    /** @returns {*} the selected key, the owner's or the list's own; null for none */
    selectedKey() {
      const key = this.selectedId !== undefined ? this.selectedId : this.ownSelected;
      return key === undefined ? null : key;
    },
    /** @returns {*} the key a shift-click ranges from */
    rangeFrom() {
      return this.selectedKey !== null ? this.selectedKey : this.anchorKey;
    },
  },
  watch: {
    items(items, oldItems) {
      if (items && items.length && (!oldItems || !oldItems.length)) this.selectFirst();
    },
    autoSelect(index) {
      const row = this.rows[parseInt(index, 10)];
      if (row) this.selectOnly(row);
    },
    search(text) {
      if (text !== undefined && text !== this.searchString) this.searchString = text;
    },
    searchString(text) {
      this.$emit('update:search', text);
    },
    /**
     * Brings a newly highlighted row into view: one picked in the 3D view is
     * otherwise somewhere down the list. A row already showing, as one just
     * clicked is, stays where it is; a band scrolls the list itself.
     */
    highlightSet(keys, oldKeys) {
      if (this.band) return;
      const added = [...keys].find((key) => !oldKeys || !oldKeys.has(key));
      if (added === undefined) return;
      this.$nextTick(() => this.scrollToKey(added));
    },
  },
  mounted() {
    if (this.rows.length) this.selectFirst();
  },
  unmounted() {
    this.endBand();
    window.removeEventListener('keydown', this.keydownListener);
    this.$emit('focused', false);
  },
  methods: {
    /**
     * The key a row is found by from the page, as the attribute holds it.
     *
     * @param {Object} row
     * @returns {String}
     */
    bandKey(row) {
      return String(row.key);
    },
    /**
     * Scrolls the body just far enough to show a row, if it is drawn. Only the
     * body scrolls, not the panels round the list.
     *
     * @param {*} key
     */
    scrollToKey(key) {
      const { body } = this.$refs;
      if (!body) return;
      const wanted = String(key);
      const row = [...body.querySelectorAll('[data-band-key]')]
        .find((el) => el.getAttribute('data-band-key') === wanted);
      if (!row) return;
      const view = body.getBoundingClientRect();
      const at = row.getBoundingClientRect();
      if (at.top < view.top) body.scrollTop -= view.top - at.top;
      else if (at.bottom > view.bottom) body.scrollTop += at.bottom - view.bottom;
    },
    /**
     * Starts a band selection, for a press on the list's own ground -- the
     * margin or the space below the rows. A press on a row is the row's.
     *
     * @param {MouseEvent} e
     */
    startBand(e) {
      if (!this.bandSelect || this.noHighlight || e.button !== 0) return;
      const { body } = this.$refs;
      if (!body || e.target.closest('.uikit_list_item')) return;
      // A press on the body's scrollbar lands on the body too; it scrolls,
      // and a band started there selects every row the drag passes.
      const rect = body.getBoundingClientRect();
      if (e.clientX - rect.left >= body.clientLeft + body.clientWidth
        || e.clientY - rect.top >= body.clientTop + body.clientHeight) return;
      e.preventDefault();
      body.focus();
      const additive = e.ctrlKey || e.shiftKey;
      this.band = {
        startY: this.bandY(e.clientY),
        clientY: e.clientY,
        moved: false,
        base: additive ? [...this.highlightSet] : [],
        applied: null,
        frame: 0,
      };
      window.addEventListener('mousemove', this.moveBand);
      window.addEventListener('mouseup', this.endBand);
      this.band.frame = requestAnimationFrame(this.scrollBand);
    },
    /**
     * A pointer height in the body's own coordinates, scroll included, so the
     * band stays anchored to rows as the list scrolls under it.
     *
     * @param {Number} clientY
     * @returns {Number}
     */
    bandY(clientY) {
      const { body } = this.$refs;
      return clientY - body.getBoundingClientRect().top + body.scrollTop;
    },
    /** @param {MouseEvent} e */
    moveBand(e) {
      if (!this.band) return;
      this.band.clientY = e.clientY;
      if (Math.abs(this.bandY(e.clientY) - this.band.startY) > 2) this.band.moved = true;
      this.applyBand();
    },
    /**
     * Highlights every row the band's height covers, on top of what it adds to.
     * Rows fill the list's width, so the band is only ever a range of heights.
     */
    applyBand() {
      const { band } = this;
      const { body } = this.$refs;
      if (!band || !body || !band.moved) return;
      const y = this.bandY(band.clientY);
      const top = Math.min(band.startY, y);
      const bottom = Math.max(band.startY, y);
      const bodyTop = body.getBoundingClientRect().top - body.scrollTop;
      const byString = new Map([...this.rowsByKey.keys()].map((key) => [String(key), key]));
      const covered = [];
      body.querySelectorAll('[data-band-key]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        const rowTop = rect.top - bodyTop;
        const rowBottom = rect.bottom - bodyTop;
        if (rowBottom > top && rowTop < bottom) {
          const key = byString.get(el.getAttribute('data-band-key'));
          if (key !== undefined) covered.push(key);
        }
      });
      const keys = [...new Set([...band.base, ...covered])];
      const signature = JSON.stringify(this.inListOrder(keys));
      if (signature === band.applied) return;
      band.applied = signature;
      this.setHighlight(keys);
    },
    /**
     * Scrolls the list while the pointer is held past its top or bottom, and
     * widens the band with it.
     */
    scrollBand() {
      const { band } = this;
      const { body } = this.$refs;
      if (!band || !body) return;
      const rect = body.getBoundingClientRect();
      let step = 0;
      if (band.clientY < rect.top) step = -Math.min(rect.top - band.clientY, 40) / 2;
      else if (band.clientY > rect.bottom) step = Math.min(band.clientY - rect.bottom, 40) / 2;
      if (step) {
        body.scrollTop += step;
        this.applyBand();
      }
      band.frame = requestAnimationFrame(this.scrollBand);
    },
    /**
     * Ends a band selection. A press that never moved is a click on empty
     * ground, which clears the highlight unless it was adding.
     */
    endBand() {
      window.removeEventListener('mousemove', this.moveBand);
      window.removeEventListener('mouseup', this.endBand);
      const { band } = this;
      if (!band) return;
      cancelAnimationFrame(band.frame);
      this.band = null;
      if (!band.moved && !band.base.length) this.setHighlight([]);
    },
    /** @returns {Boolean} */
    isHighlighted(row) {
      return !this.noHighlight && this.highlightSet.has(row.key);
    },
    /** @returns {Boolean} */
    isSelected(row) {
      return this.selectedKey !== null && row.key === this.selectedKey;
    },
    /** @returns {Boolean} */
    isOpen(row) {
      return !!row.opened || this.openKeys.includes(row.key);
    },
    /**
     * Keys in the order their rows appear, children after their parent.
     *
     * @param {Iterable} keys
     * @returns {Array}
     */
    inListOrder(keys) {
      const wanted = new Set(keys);
      return [...this.rowsByKey.keys()].filter((key) => wanted.has(key));
    },
    /** Opens or selects the first row, for `autoSelectFirst`. */
    selectFirst() {
      if (!this.autoSelectFirst || !this.rows[0]) return;
      const first = this.rows[0];
      if (first.children) {
        if (!this.isOpen(first)) this.openKeys = [...this.openKeys, first.key];
      } else {
        this.selectOnly(first);
      }
    },
    /**
     * Sets the highlighted rows and reports them.
     *
     * @param {Array} keys
     */
    setHighlight(keys) {
      const ordered = this.inListOrder(keys);
      if (!Array.isArray(this.highlightIds)) this.ownHighlight = ordered;
      /**
       * The rows highlighted, all of them, in list order
       *
       * @property {Array} values their items
       */
      this.$emit('highlight', ordered.map((key) => this.rowsByKey.get(key).value));
    },
    /**
     * Selects a row and reports it.
     *
     * @param {Object} row
     */
    setSelected(row) {
      if (this.selectedId === undefined) this.ownSelected = row.key;
      this.anchorKey = row.key;
      /**
       * Row selected
       *
       * @property {Object} value its item
       */
      this.$emit('select', row.value);
    },
    /**
     * A plain click: this row and no other.
     *
     * @param {Object} row
     */
    selectOnly(row) {
      if (!this.noHighlight) this.setHighlight([]);
      this.setSelected(row);
    },
    /**
     * Ctrl-click: adds the row to the highlight, or takes it out. A single
     * selection already made is where the set starts.
     *
     * @param {Object} row
     */
    toggleHighlight(row) {
      const keys = [...this.highlightSet];
      if (!keys.length && this.selectedKey !== null && this.selectedKey !== row.key) {
        keys.push(this.selectedKey);
      }
      const at = keys.indexOf(row.key);
      if (at === -1) keys.push(row.key);
      else keys.splice(at, 1);
      const anchor = this.rowsByKey.get(this.rangeFrom) || this.rowsByKey.get(keys[0]);
      if (anchor) this.setSelected(anchor);
      this.setHighlight(keys);
    },
    /**
     * Shift-click: every row from the anchor to this one, among the rows it
     * sits with.
     *
     * @param {Object} row
     * @param {Array} siblings the rows it sits with -- the top level, or a
     *   folder's children
     */
    selectRange(row, siblings) {
      const keys = siblings.map((entry) => entry.key);
      const from = keys.indexOf(this.rangeFrom);
      const to = keys.indexOf(row.key);
      if (from === -1) {
        this.selectOnly(row);
        return;
      }
      if (from === to) return;
      this.setHighlight(keys.slice(Math.min(from, to), Math.max(from, to) + 1));
    },
    /**
     * A click on a row, with whatever modifier it carried.
     *
     * @param {Event} e click event
     * @param {Object} row
     * @param {Array} siblings the rows it sits with
     */
    clickRow(e, row, siblings) {
      if (row.value.disabled || this.dragging) return;
      if (this.openFolders && row.children && row.children.length) {
        this.unfold(row);
        return;
      }
      if (e && e.shiftKey && !this.noHighlight) this.selectRange(row, siblings);
      else if (e && e.ctrlKey && !this.noHighlight) this.toggleHighlight(row);
      else this.selectOnly(row);
    },
    /**
     * Opens or closes a row's children. In accordion mode the row opened is
     * the only one open.
     *
     * @param {Object} row
     */
    /**
     * Reports a row double-clicked: opened, as against chosen.
     *
     * @public
     * @param {Object} row
     */
    activate(row) {
      this.$emit('activate', row.value);
    },
    unfold(row) {
      const open = this.openKeys.includes(row.key);
      if (this.accordion) this.openKeys = [row.key];
      else if (open) this.openKeys = this.openKeys.filter((key) => key !== row.key);
      else this.openKeys = [...this.openKeys, row.key];
      /**
       * Row opened or closed
       *
       * @property {Object} value its item
       */
      this.$emit('unfold', row.value);
    },
    /** Handler for list focus-in. */
    handleFocusIn() {
      this.hasFocus = true;
      /**
       * List focus state
       *
       * @property {Boolean} focused
       */
      this.$emit('focused', true);
      window.addEventListener('keydown', this.keydownListener);
    },
    /** Handler for list focus-out. */
    handleFocusOut() {
      this.hasFocus = false;
      // The keys belong to the list only while it has focus.
      window.removeEventListener('keydown', this.keydownListener);
      this.$emit('focused', false);
    },
    /**
     * Drops the highlight, and optionally the focus with it.
     *
     * @param {Boolean} [focusOut]
     */
    clearHighlighted(focusOut = false) {
      if (this.noHighlight) return;
      this.setHighlight([]);
      if (focusOut) {
        this.$emit('focused', false);
        this.hasFocus = false;
      }
    },
    /**
     * Deletes what is selected, there and then.
     *
     * No confirmation: the same key in the 3D view does not ask either, and a
     * list that stopped to check while the scene did not would be the odd one
     * out rather than the careful one.
     *
     * @public
     */
    handleDeletion() {
      if (!this.deletable || !this.hasFocus) return;
      let keys = [];
      if (this.highlightSet.size) keys = this.inListOrder(this.highlightSet);
      else if (this.selectedKey !== null) keys = [this.selectedKey];
      const values = keys
        .map((key) => this.rowsByKey.get(key))
        .filter(Boolean)
        .map((row) => row.value);
      if (!values.length) return;
      /**
       * Rows to delete
       *
       * @property {Array} values their items
       */
      this.$emit('delete', values);
      this.clearHighlighted();
    },
    /**
     * Keydown event listener.
     *
     * @param {Event} e keydown event
     */
    keydownListener(e) {
      // Keys typed into a field, the list's own search box included, edit the
      // text and nothing else.
      const { target } = e;
      if (target && (target.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const { key } = e;
      if (key === 'Delete') {
        this.handleDeletion();
      } else if (key === 'Escape') {
        this.clearHighlighted(true);
      }
    },
    /**
     * Begins a drag.
     *
     * The list reports where things were dropped and lets its owner decide what
     * that means; it does not reorder anything itself. Its items come from the
     * owner, who is the one that can change their order.
     *
     * @param {Event} e dragstart event
     * @param {Object} row row being dragged
     */
    startDrag(e, row) {
      this.dragging = true;
      this.draggedKey = row.key;
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    /**
     * Picks the gap under the pointer: above a row over its top half, below it
     * over the bottom half.
     *
     * @param {Event} e dragover event
     * @param {Number} index row being hovered
     */
    dragOver(e, index) {
      if (!this.dragging) return;
      const rect = e.currentTarget.getBoundingClientRect();
      let gap = e.clientY > rect.top + rect.height / 2 ? index + 1 : index;
      // The gaps on either side of the dragged row put it back where it was --
      // unless it carries other highlighted rows, which a drop there gathers.
      const from = this.rows.findIndex((row) => row.key === this.draggedKey);
      const alone = !this.highlightSet.has(this.draggedKey)
        || ![...this.highlightSet].some((key) => key !== this.draggedKey);
      if (alone && from !== -1 && (gap === from || gap === from + 1)) gap = null;
      this.dropIndex = gap;
      if (e.dataTransfer) e.dataTransfer.dropEffect = gap === null ? 'none' : 'move';
    },
    /**
     * Hides the drop line once the pointer is off the list.
     *
     * @param {Event} e dragleave event
     */
    dragLeave(e) {
      if (!e.currentTarget.contains(e.relatedTarget)) this.dropIndex = null;
    },
    /**
     * Reports the drop as a row and a side of it, which stays correct while
     * a search is hiding rows.
     */
    drop() {
      const dragged = this.rowsByKey.get(this.draggedKey);
      const gap = this.dropIndex;
      this.stopDrag();
      const { rows } = this;
      if (!dragged || gap === null || !rows.length) return;
      const below = gap >= rows.length;
      /**
       * Reordering event
       *
       * @property {Object} item the dragged item's value
       * @property {Object} target the row it was dropped next to
       * @property {String} position 'before' or 'after' that row
       */
      this.$emit('reorder', {
        item: dragged.value,
        target: rows[below ? rows.length - 1 : gap].value,
        position: below ? 'after' : 'before',
      });
    },
    /**
     * Ends a drag, dropped or not. dragend fires after drop, and a drag
     * cancelled with Escape or released off the list reaches here alone.
     */
    stopDrag() {
      this.dragging = false;
      this.draggedKey = null;
      this.dropIndex = null;
    },
  },
};
</script>
<style scoped>
</style>

<style scoped>
.uikit_list_search {
  display: flex;
  align-items: center;
  gap: 4px;
}
.uikit_list_searchbox {
  flex: 1;
  min-width: 0;
}
/* Filter buttons stand as tall as the search box beside them. */
.uikit_list_search :deep(.uikit_button.icon_only) {
  width: 25px;
  min-width: 25px;
  height: 25px;
}
.uikit_list_search :deep(.uikit_button.icon_only .uikit_button_icon) {
  width: 15px !important;
  height: 15px !important;
}
.uikit_list {
  display: flex;
  flex-direction: column;
  width: fit-content;
  background: var(--primary-light);
  height: 100%;
  width: 100%;
  user-select: none;
}
.uikit_list_body {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  align-items: center;
  overflow: hidden;
  overflow-y: auto;
  outline: none !important;
}
.uikit_list_item {
  width: 100%;
}
/* Ground to start a band selection on: a margin either side of the rows and
   room below the last one, which a press on a row can never reach. */
.uikit_list_body.band {
  padding: 0 8px 32px;
  box-sizing: border-box;
}
.uikit_list_body_empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  color: var(--secondary-light);
  text-transform: uppercase;
  font-family: roboto-regular;
  background:
    var(--primary-light)
    repeating-linear-gradient(
      45deg,
      #1619130a,
      #1619130a 10px,
      #0c0e0a38 10px,
      #0c0e0a38 20px
    );
  border-bottom: 1px solid var(--primary-dark);
}
.uikit_list_body_empty > h3 {
  color: var(--secondary-light);
  text-transform: uppercase;
  font-family: roboto-regular;
}
.uikit_list_header_button {
  cursor: pointer;
}
.uikit_list_item_unfoldable {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.uikit_sublist_body {
  padding-left: 16px !important;
}
.uikit_sublist_body_empty {
  flex:1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.delete_popup_buttons {
  display: flex;
  gap: 8x;
  padding: 8px 0px;
  padding-right: 8px;
  border-top: 1px solid var(--primary-dark);
  align-items: center;
  justify-content: center;
}
.dragged {
  border: 1px dashed var(--secondary-light) !important;
}
.uikit_list_item.parent {
  position: relative;
}
.drop_before::before,
.drop_after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent-teal);
  pointer-events: none;
  z-index: 1;
}
.drop_before::before {
  top: -1px;
}
/* A rule above a row that starts a new group, as menus divide their items. */
.uikit_list_item.separated {
  margin-top: 4px;
  border-top: 1px solid var(--primary-dark);
  padding-top: 4px;
}
.drop_after::after {
  bottom: -1px;
}
</style>
