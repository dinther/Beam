<template>
  <div
    :class="{ docked, disabled }"
    class="widget"
  >
    <div class="header">
      <span
        v-if="header.icon"
        class="header_glyph"
      >
        <uk-icon
          class="header_icon"
          :name="header.icon"
        />
        <!-- A badge on the icon's lower-right corner, drawn the same way the
             list item marks its rows. -->
        <uk-icon
          v-if="header.overlay"
          class="header_overlay"
          :name="header.overlay"
        />
      </span>
      <h3>{{ header.title }}</h3>
      <span style="flex: 1" />
      <uk-button
        v-if="action"
        v-show="!docked"
        :label="action.text"
        :icon="action.icon"
        @click="action.callback"
      />
      <uk-icon
        v-if="dockable"
        class="widget_action"
        name="arrow_down"
        @click="docked = !disabled && !docked"
      />
    </div>
    <div
      v-show="!docked"
      class="body"
    >
      <slot />
    </div>
  </div>
</template>
<script>
/**
 * @component Widget Widgets are used within modifiers in order to offer users with unique
 * ways to interract with a modifier.
 * @namespace uikit/widgets
 * @story Default {"header":{"title":"Default","icon":"grid"}}
 * @story Disabled {"header":{"title":"Default","icon":"grid"}, "disabled":true}
 * @story Dockable {"header":{"title":"Default","icon":"grid"}, "dockable":true}
 */
export default {
  name: 'UkWidget',
  compatConfig: {
    // or, for full vue 3 compat in this component:
    MODE: 3,
  },
  props: {
    /**
     * Header Definition object:
     * {title: "String", icon: "String"}
     */
    header: {
      type: Object,
      default: () => ({
        title: 'Unnamed Widget',
      }),
    },
    /**
     * Whether the widget is dockable or not
     */
    dockable: {
      type: Boolean,
      default: false,
    },
    /**
     * An action configuration object:
     * {text: "String", icon: "String", callback: ()=>{console.log("Hello World")}}
     */
    action: {
      type: Object,
      default: null,
    },
    /**
     * Whether the widget should be docked by default
     */
    defaultDocked: Boolean,
    /**
     * Whether the widget is disabled or not
     */
    disabled: Boolean,
  },
  data() {
    return {
      /**
       * The widget's docking state
       */
      docked: this.defaultDocked,
    };
  },
};
</script>
<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: all 0.2s;
  max-width: 230px;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
  max-width: 0px;
}
</style>

<style scoped>
.widget {
  display: flex;
  flex-direction: column;
  height: fit-content;
  border-right: 1px solid var(--primary-dark);
  background: var(--primary-light);
  user-select: none;
  overflow: hidden;
  height: 100%;
  min-width: 150px;
  transition: all .15s ease-in;
  white-space: nowrap;
}
.header {
  display: flex;
  flex-direction: row;
  min-height: 24px;
  width: 100%;
  padding: 0 6px;
  align-items: center;
  border-bottom: 1px solid var(--primary-dark);
  user-select: none;
}
.header_glyph {
  position: relative;
  display: flex;
  flex: none;
  margin-right: 6px;
  height: 12px;
  width: 12px;
}
.header_icon {
  fill: var(--secondary-lighter) !important;
  height: 12px !important;
  width: 12px !important;
}
.header_overlay {
  position: absolute;
  right: -5px;
  bottom: -4px;
  width: 10px !important;
  height: 10px !important;
  padding: 1px;
  border-radius: 50%;
  background: var(--primary-light);
  fill: var(--accent-teal) !important;
}
.widget.docked {
  min-width: 30px !important;
  max-width: 30px !important;
}
.docked .widget_action {
  margin: unset !important;
  transform: rotate(180deg);
}
.widget_action {
  width: 10px !important;
  height: 10px !important;
  fill: var(--secondary-lighter);
  margin-left: 8px;
}
.widget_action:hover {
  cursor: pointer;
}
.body {
  display: flex;
  flex-direction: row;
  /* Top, not centred. A widget's content reads from the top like anything
     else, and centring it floats short content in the middle of a tall panel
     with a gap above it. Set here, in the shared default, so every widget
     follows.

     Centring would also put overflow half above the container, where no
     scrollbar can reach. Aligned to the start there is nothing above to lose. */
  align-items: flex-start;
  height: 100%;
  width: 100%;
  /* Scrolls rather than clips. A widget taller than the space it is given used
     to lose whatever did not fit, silently and from whichever end the layout
     ran out. min-height lets a flex child shrink under its own content, which
     is what allows the scrollbar to appear at all. */
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.docked .header {
  width: 30px !important;
  height: 100%;
  text-align: left;
  justify-content: center;
  text-orientation: vertical-rl;
  padding-bottom: 10px;
  padding-top: 10px;
  flex-direction: column-reverse;
  background:
    repeating-linear-gradient(
      45deg,
      var(--primary-light),
      var(--primary-light) 10px,
      var(--primary-dark) 10px,
      var(--primary-dark) 20px
    );
}
.docked .header_glyph {
  margin: 0 !important;
  margin-top: 8px !important;
}
.docked h3 {
  writing-mode: vertical-lr;
  text-orientation: mixed;
  transform: scale(-1);
}
.disabled .header_icon,
.disabled .header_overlay,
.disabled .widget_action {
  fill: var(--secondary-light) !important;
  cursor: unset;
}
.disabled h3 {
  color: var(--secondary-light) !important;
}
</style>
