<template>
  <div
    class="uikit_list_item"
    :class="{
      highlighted: highlighted && !noHighlight,
      selected: selected,
      unfold: value.unfold,
      unfolded: unfolded && value.unfold.length,
      deletable: deletable,
      focused: focused,
      disabled: value.disabled || disabled,
      dimmed: value.dimmed,
      empty: empty,
      tall: tall,
      noSelect: noSelect,
    }"
    @click="(e)=>$emit('click',e)"
  >
    <span
      v-if="!value.icon && colored && value.color"
      class="uikit_list_item_colored_dot"
      :style="{
        backgroundColor: unfolded ? value.color : 'transparent',
        borderColor: value.color
      }"
    />
    <span
      v-if="value.icon"
      class="uikit_list_item_glyph"
    >
      <uk-icon
        class="uikit_list_item_icon"
        :name="value.icon"
      />
      <!-- A library reference: the item points at a library entry rather
           than carrying its definition in the show. -->
      <uk-icon
        v-if="value.overlay"
        class="uikit_list_item_overlay"
        :name="value.overlay"
      />
    </span>
    <h4>{{ value.name }}</h4>
    <div style="flex: 1" />
    <h4
      v-if="value.more"
      class="uikit_list_item_more"
    >
      {{ value.more }}
    </h4>
    <!-- A short label in a column of its own, the same width on every row. -->
    <h4
      v-if="value.tag"
      class="uikit_list_item_more uikit_list_item_tag"
    >
      {{ value.tag }}
    </h4>
    <uk-button
      v-if="value.action"
      :icon="value.action.icon"
      :label="value.action.label"
      @click="value.action.callback"
    />
    <!-- Several actions on one row. `action` stays for the single-button case
         it already serves.
         No `.stop` here, for two reasons. `uk-button` emits its own `click`
         carrying a boolean rather than the DOM event, so the modifier would
         call `stopPropagation` on `false` and throw. And it is not needed: the
         button's own root already stops the native click, so the row's handler
         never sees it. -->
    <uk-button
      v-for="(entry, actionIndex) in (value.actions || [])"
      :key="actionIndex"
      :class="['uikit_list_item_action', {
        bare: !entry.label,
        active: entry.active,
        small: entry.small,
      }]"
      :icon="entry.icon"
      :label="entry.label"
      :title="entry.title"
      :flat="!entry.label"
      :icon-only="!entry.label"
      :disabled="entry.disabled"
      @click="entry.callback"
    />
    <uk-icon
      v-if="value.unfold"
      class="uikit_list_item_icon_small unfold_arrow"
      :class="{ folded: !unfolded }"
      name="arrow_down"
      @click.stop="$emit('unfold')"
    />
    <uk-icon
      v-if="deletable"
      class="uikit_list_item_icon_small"
      name="cross"
    />
  </div>
</template>

<script>
export default {
  name: 'UkListItem',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * What the row shows: `name`, and optionally `icon`, `more`, `tag`,
     * `color`, `unfold` and the rest.
     */
    value: {
      type: Object,
      default: () => ({}),
    },
    /** Whether this is the row whose details are open. */
    selected: Boolean,
    /** Whether the row is part of a selection of several. */
    highlighted: Boolean,
    /** Whether the row's children are showing. */
    unfolded: Boolean,
    /**
     * Whether item highlighting should be disabled orr not
     */
    noHighlight: Boolean,
    /**
     * Whether alternative colored styling should be applied
     */
    colored: Boolean,
    /**
     * Whether the item is deletable
     */
    deletable: Boolean,
    /**
     * Item's focus state
     */
    focused: Boolean,
    /**
     * Whether the item is disabled
     */
    disabled: Boolean,
    /**
     * Whether alternative "tall" styling t=should be applied (40px height)
     */
    tall: Boolean,
    /**
     * Whether item selected styling should be disabled whatsoever
     */
    noSelect: Boolean,
    /**
     * Whether the item is an empty placehoder
     */
    empty: Boolean,
  },
  emits: ['unfold', 'click'],
};
</script>

<style scoped>
/*
 * File-explorer convention: pointing right when closed, down when open. One
 * asset rotated rather than two, so both states are drawn at the same weight --
 * the previous pair dimmed the open arrow to half opacity, which made an open
 * row read as having no arrow at all.
 */
.unfold_arrow {
  transition: transform 120ms ease;
  cursor: pointer;
}
.unfold_arrow.folded {
  transform: rotate(-90deg);
}
@media (prefers-reduced-motion: reduce) {
  .unfold_arrow { transition: none; }
}

.uikit_list_item {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 30px;
  border-top: 1px solid transparent;
  border-bottom: 1px solid var(--primary-dark);
  padding: 0 8px;
  width: 100%;
  background: var(--primary-light);
  opacity: 0.9;
  transition: background-color 0.1s;
  gap: 10px;
}
.tall {
  min-height: 40px !important;
}
.uikit_list_item h4 {
  font-family: Roboto-medium;
}
.unfold h4 {
  font-family: Roboto-bold !important;
}
.uikit_list_item_unfoldable {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.uikit_list_item:hover {
  background: var(--secondary-darker);
  cursor: pointer;
}
.deletable .uikit_list_item_icon_small {
  display: none !important;
}
.deletable:hover .uikit_list_item_icon_small,
.deletable.selected .uikit_list_item_icon_small {
  display: initial !important;
}
.selected:not(.noSelect){
  background: rgba(28, 166, 189, 0.16) !important;
  opacity: 1;
}
.selected.highlighted:not(.noSelect) {
  background: rgba(28, 166, 189, 0.16) !important;
  opacity: 1;
}
.selected.focused:not(.noSelect) {
  background-color: var(--accent-teal)!important;
  border-color: var(--accent-teal)!important;
  opacity: 1;
}
/* Same tint as .selected: a highlighted row belongs to the selection whether
   or not the list happens to hold focus. Focused styling below still promotes
   both states to solid accent. */
.highlighted:not(.noSelect){
  background: rgba(28, 166, 189, 0.16) !important;
}
/* Darker than the selected row's teal: white on the bright accent is about
   3:1 and hard to read across a column of rows, where this is about 5:1 --
   and it keeps the one selected row standing out from the rest. */
.highlighted.focused:not(.noSelect)  {
  border-color: #127080 !important;
  background: #127080 !important;
}
/* On either solid fill the text and glyph go white, and the row drops its
   resting translucency: grey on teal is what made these hard to read. */
.highlighted.focused:not(.noSelect),
.selected.focused:not(.noSelect) {
  opacity: 1;
}
.highlighted.focused:not(.noSelect) h4,
.selected.focused:not(.noSelect) h4 {
  color: #fff !important;
}
.highlighted.focused:not(.noSelect) .uikit_list_item_glyph :deep(svg),
.selected.focused:not(.noSelect) .uikit_list_item_glyph :deep(svg) {
  fill: #fff !important;
}
.highlighted.focused:not(.noSelect) .uikit_list_item_more,
.selected.focused:not(.noSelect) .uikit_list_item_more {
  color: rgba(255, 255, 255, 0.85) !important;
}
.unfold:active {
  background: var(--secondary-dark) !important;
}
.uikit_list_item_icon {
  /* margin-right: 10px; */
  width: 14px !important;
  height: 14px !important;
  fill: var(--secondary-lighter) !important;
}
.uikit_list_item_icon_small {
  width: 10px !important;
  height: 10px !important;
  fill: var(--secondary-lighter) !important;
}
/* The overlay sits on the icon's lower-right corner, backed by the row colour
   so it reads as a badge and not as part of the glyph under it. */
.uikit_list_item_glyph {
  position: relative;
  display: flex;
  width: 14px;
  height: 14px;
  flex: none;
}
.uikit_list_item_overlay {
  position: absolute;
  right: -5px;
  bottom: -4px;
  width: 11px !important;
  height: 11px !important;
  padding: 1px;
  border-radius: 50%;
  background: var(--primary-light);
  fill: var(--accent-teal) !important;
}
.disabled .uikit_list_item_overlay {
  fill: var(--secondary-light) !important;
}
.uikit_list_item.unfold {
  min-height: 30px;
  max-height: 30px;
  height: unset !important;
  font-weight: bold;
}
.unfold > .uikit_list_item {
  margin-left: 16px !important;
}
.uikit_list_item_colored_dot {
  height: 8px;
  width: 8px;
  border-radius: 50%;
  background: #533aaa;
  /* margin-right: 8px; */
  border: 1px solid;
}
.uikit_list_item_action {
  /* Small enough that three of them sit on a row without crowding the name. */
  padding: 1px 6px;
  font-size: 10px;
  min-width: 0;
  opacity: 0.75;
  /* A long name gives up the width, not the button: shrinking it squeezes
     the glyph narrower than on the other rows. */
  flex-shrink: 0;
}

/* An icon on its own is a state, not a button. The background is the button's
   own `flat` variant; what is left here is size and colour, because its
   `icon_only` rule sizes it for a toolbar. */
.uikit_list_item_action.bare {
  /* Size is the button's own `flat` rule; only the colour is decided here. */
  padding: 0;
  margin-left: 4px;
}

/* Set on the glyph itself rather than relying on `currentColor` inheriting: an
   icon is a separate component, and `fill` as an SVG attribute is a
   presentation hint that any stylesheet outranks. Addressing `fill` directly
   is the one thing that cannot be quietly overridden.
   Off is 39% white against a full white on -- `--secondary-lighter` is
   #FFFFFFC7, 78%, too close to on to read. */
.uikit_list_item_action.bare :deep(svg) {
  fill: var(--secondary-light-alt);
}

.uikit_list_item_action.bare.active :deep(svg) {
  fill: #fff;
}

.uikit_list_item_action.bare:hover :deep(svg) {
  fill: var(--secondary-lighter);
}

.uikit_list_item_action:hover {
  opacity: 1;
}

/* A quieter toggle, for one on every row where the name should lead. Spelled
   out to outrank the button's own flat glyph size, which is !important. */
.uikit_list_item .uikit_list_item_action.bare.small.icon_only :deep(.uikit_button_icon) {
  width: 12px !important;
  height: 12px !important;
}

/* The other way round from an ordinary toggle: bright while the item is in
   the scene, dim once it is hidden, so the icon fades with what it hides.
   The same glyph colour both ways -- the difference is the opacity alone.
   Hover brings a dim one back. */
.uikit_list_item_action.bare.small :deep(svg),
.uikit_list_item_action.bare.small.active :deep(svg) {
  fill: var(--secondary-lighter);
}
.uikit_list_item_action.bare.small.active:not(:hover) {
  opacity: 0.4;
}

/* Present but out of the picture -- a hidden scene item. Still a row that can
   be clicked, unlike `disabled`; only its glyph and text recede, so the
   toggles at the end stay as readable as on any other row. */
.uikit_list_item.dimmed > .uikit_list_item_glyph,
.uikit_list_item.dimmed > h4 {
  opacity: 0.4;
}
/* Less so on a solid highlight, where 40% of white sinks into the teal. */
.uikit_list_item.dimmed.highlighted.focused > .uikit_list_item_glyph,
.uikit_list_item.dimmed.highlighted.focused > h4,
.uikit_list_item.dimmed.selected.focused > .uikit_list_item_glyph,
.uikit_list_item.dimmed.selected.focused > h4 {
  opacity: 0.65;
}

.uikit_list_item_more {
  /* Kept whole, an address range is read to patch the next fixture; the
     name shortens instead. */
  flex: none;
  color: var(--secondary-light-alt);
  font-family: roboto-regular!important;
}
.uikit_list_item_tag {
  flex: none;
  width: 52px;
  margin-left: 10px;
  text-align: left;
}
.selected.focused .uikit_list_item_more{
  color: var(--secondary-lighter)!important
}
.disabled h4 {
  color: var(--secondary-light) !important;
}
.disabled .uikit_list_item_icon {
  fill: var(--secondary-light) !important;
}
.disabled:hover {
  background: unset;
  cursor: unset;
}
.empty {
  background: var(--primary-light) repeating-linear-gradient(
    45deg,
   #1619130a,
    #1619130a 10px,
    #0c0e0a38 10px,
    #0c0e0a38 20px
  );
  text-transform: uppercase!important;
}
.unfold{
  flex: 1
}
</style>
