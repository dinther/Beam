<template>
  <div
    tabindex="0"
    class="menus"
    @focusout="handleFocusOut"
  >
    <div
      v-for="(menu, index) in mens"
      :key="index"
      class="menu"
      @mouseover="handleHover(menu)"
      @click="select(menu)"
    >
      <div
        class="header_menu"
        :class="{ selected: menu.selected }"
      >
        <h3>{{ menu.name }}</h3>
      </div>
      <div
        v-show="menu.selected"
        class="menu_list"
        @mouseover="(e) => hoverItem(e, menu)"
      >
        <uk-list
          tall
          class="list"
          no-highlight
          no-select
          :items="menu.items"
          @select="selectSubItem"
          @selected="afterSelect"
        />
      </div>
      <!-- An item's submenu, beside the row it belongs to. -->
      <div
        v-if="flyout && flyout.menu === menu && menu.selected"
        class="menu_list menu_flyout"
        :style="{ top: `${flyout.top}px`, left: `${flyout.left}px` }"
        @click.stop
      >
        <uk-list
          tall
          class="list"
          no-highlight
          no-select
          :items="flyoutItems"
          @select="selectFlyoutItem"
        />
      </div>
    </div>
  </div>
</template>

<script>

/**
 * Shortcut string special values
 *
 * @constant {Object} SHORTCUT_KEYS_STR
 */
const SHORTCUT_KEYS_STR = {
  ctrl: 'ctrlKey',
  shift: 'shiftKey',
};

export default {
  name: 'UkMenu',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    menus: {
      type: Array,
      default: () => [],
    },
  },
  data() {
    return {
      /**
       * Current menu disaply state
       */
      displayState: false,
      mens: [],
      /** The open submenu: `{ menu, item, top, left }`, or null. */
      flyout: null,
      /** Set when a click opened a submenu, so the menu stays open. */
      keepOpen: false,
    };
  },
  computed: {
    /** The open submenu's items, or a line saying it is empty. */
    flyoutItems() {
      if (!this.flyout) return [];
      const items = this.flyout.item.submenu || [];
      return items.length ? items : [{ name: this.flyout.item.empty || 'Nothing here', inert: true }];
    },
  },
  mounted() {
    this.initializeMenus();
  },
  beforeUnmount() {
    // window.removeEventListener("keydown", shortcuCallback);
  },
  methods: {
    initializeMenus() {
      this.mens = this.menus.map((menu) => {
        menu.items = menu.items.map((item) => {
          if (item.shortcut) {
            const shortcuCallback = (e) => {
              if (this.parseAndEvaluateShortcut(e, item.shortcut)) {
                e.preventDefault();
                item.callback();
              }
            };
            window.addEventListener('keydown', shortcuCallback);
          }
          // `hint` shows a shortcut that something else already handles, such
          // as Ctrl+C, without the menu listening for it too.
          const keys = item.shortcut || item.hint;
          if (keys) item.more = `(${keys})`;
          else if (item.more === undefined) item.more = '';
          return item;
        });
        return menu;
      });
    },
    /**
     * Handles component focus out
     *
       * @param {Object} e Focus event
     */
    handleFocusOut(e) {
      if (!this.$el.contains(e.relatedTarget) && !this.$el.contains(e.explicitOriginalTarget)) {
        this.unselectAll();
        this.displayState = false;
      }
    },
    /**
     * Handles menu hovering.
     *
       * @param {Object} menu Handle to the menu item being hovered
     */
    handleHover(menu) {
      if (this.displayState) {
        this.mens.forEach((item) => {
          item.selected = false;
        });
        menu.selected = true;
      }
    },
    /**
     * Unselects all menu items.
     *
       */
    unselectAll() {
      this.flyout = null;
      this.mens.forEach((menu) => {
        menu.selected = false;
      });
    },
    /**
     * Opens the submenu of the item under the pointer, beside its row, or
     * closes the one open when the pointer is on another item.
     *
     * @param {Event} e mouseover in a menu's list
     * @param {Object} menu the menu
     */
    hoverItem(e, menu) {
      const row = e.target.closest && e.target.closest('.uikit_list_item.parent');
      if (!row) return;
      const rows = [...row.parentElement.children].filter((el) => el.classList.contains('parent'));
      const item = menu.items[rows.indexOf(row)];
      if (!item || !item.submenu) {
        this.flyout = null;
        return;
      }
      if (this.flyout && this.flyout.item === item) return;
      const rect = row.getBoundingClientRect();
      this.flyout = {
        menu, item, top: rect.top, left: rect.right,
      };
    },
    /**
     * After an item is chosen: the menu closes, unless the item only opened
     * its submenu.
     */
    afterSelect() {
      if (this.keepOpen) return;
      this.unselectAll();
    },
    /**
     * Runs a submenu item and closes the menu.
     *
     * @param {Object} item
     */
    selectFlyoutItem(item) {
      this.unselectAll();
      this.displayState = false;
      if (!item.inert && item.callback) item.callback();
    },
    /**
     * Selects a single menu item. Unselects every other
     *
       * @param {Object} menu Handle to the menu to be selected
     */
    select(menu) {
      // The click that opened a submenu bubbles here; the menu stays as it is.
      if (this.keepOpen) {
        this.keepOpen = false;
        return;
      }
      this.displayState = !this.displayState;
      const state = !menu.selected;
      this.mens.forEach((item) => {
        item.selected = false;
      });
      menu.selected = state;
    },
    /**
     * Executes menu sub item callback.
     *
       * @param {Object} subItem Handle to the menu's subitem to be selected
     */
    selectSubItem(subItem) {
      // An item with a submenu only opens it; hovering already has.
      if (subItem.submenu) {
        this.keepOpen = true;
        return;
      }
      subItem.callback();
    },
    /**
     * Parses and evaluates shortcut strings.
     * Shortcut strings should be described as follows:
     * "SHORTCUT_KEYS_STR+keyValue+..." eg: Ctrl+S, Ctrl+Shift+S
     *
       * @param {Object} e Keydown Event
     * @param {String} shortcutString The shortcut string to be parsed and evaluated
     */
    parseAndEvaluateShortcut(e, shortcutString) {
      const keys = shortcutString.split('+');
      const conditionStr = keys
        .map((key) => {
          key = key.toLowerCase();
          // eslint-disable-next-line no-unused-vars
          const eKey = e.key.toLowerCase();
          return `${SHORTCUT_KEYS_STR[key] ? `e.${SHORTCUT_KEYS_STR[key]}` : `"${eKey}" === '${key.toLowerCase()}'`}`;
        })
        .join('&&');
      // eslint-disable-next-line no-eval
      return eval(conditionStr);
    },
  },
};
</script>

<style scoped>

.menus {
  display: flex;
  height: 100%;
}
.header_menu {
  height: 100%;
  width: 100%;
  z-index: 10;
  justify-content: center;
  align-items: center;
  display: flex;
  padding: 0 16px;
  background: var(--primary-light);
}
.menu {
  display: flex;
  align-items: center;
  height: 100%;
  width: 100%;
  border-right: 1px solid var(--primary-dark);
  z-index: 10;
  justify-content: left;
  align-items: center;
}
.header_menu:hover {
  cursor: pointer;
  background: var(--secondary-darker);
}
.menu_list {
  position: absolute;
  top: 40px;
  margin-left: -1px;
  z-index: 1;
  /* box-shadow: 0px 10px 15px 1px var(--primary-dark); */
  box-shadow: -2px 10px 15px 0px rgba(0,0,0,.6);
  border: 1px solid var(--primary-dark);
  border-top: none;
  border-bottom: none;
  overflow: hidden;
}
/* Fixed, at the row it opens from: the menu list clips what overflows it. */
.menu_flyout {
  position: fixed;
  margin-left: 0;
  border-top: 1px solid var(--primary-dark);
  border-bottom: 1px solid var(--primary-dark);
}
.list {
  background: #22251f;
  z-index: -1;
  min-width: 250px;
}
.selected {
  background: var(--secondary-darker);
}
</style>
