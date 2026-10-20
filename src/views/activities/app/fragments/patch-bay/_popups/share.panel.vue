<template>
  <uk-flex
    col
    :gap="6"
    class="share_panel"
    :class="{ share_panel_marked: marked }"
  >
    <template v-if="mode === 'library' && entry">
      <uk-flex
        :gap="8"
        center-h
      >
        <p class="share_text share_grow">
          In your library · {{ entryText }}
        </p>
        <div class="share_marks">
          <uk-button
            icon="heart"
            icon-only
            square
            toggleable
            :model-value="favourite"
            color="var(--accent-pink)"
            :disabled="busy"
            :label="favourite ? 'Favourite: click to unmark' : 'Mark as favourite'"
            @click="$emit('favourite', !favourite)"
          />
          <uk-button
            icon="thumbs_down"
            icon-only
            square
            toggleable
            :model-value="bad"
            color="var(--accent-orange)"
            :disabled="busy"
            :label="badTitle"
            @click="$emit('mark-bad', !bad)"
          />
          <uk-button
            v-if="entry.gdtf"
            icon="cross"
            icon-only
            square
            :disabled="busy"
            label="Remove this file from your library"
            @click="$emit('remove')"
          />
        </div>
      </uk-flex>
      <uk-flex
        v-if="fixture"
        :gap="8"
        center-h
      >
        <p class="share_heading share_grow">
          Newer revision on GDTF Share: {{ newerText }}
        </p>
        <div class="share_buttons">
          <uk-button
            label="update"
            :disabled="busy"
            title="Download it into your library beside this one"
            @click="$emit('update')"
          />
        </div>
      </uk-flex>
    </template>

    <template v-else-if="mode === 'fixture' && fixture">
      <uk-flex
        :gap="8"
        center-h
      >
        <p class="share_heading share_grow">
          On GDTF Share · {{ uploader }}
        </p>
        <div class="share_marks">
          <uk-button
            icon="heart"
            icon-only
            square
            toggleable
            :model-value="favourite"
            color="var(--accent-pink)"
            :disabled="busy"
            :label="favourite ? 'Favourite: click to unmark' : 'Mark as favourite'"
            @click="$emit('favourite', !favourite)"
          />
          <uk-button
            icon="thumbs_down"
            icon-only
            square
            toggleable
            :model-value="bad"
            color="var(--accent-orange)"
            :disabled="busy"
            :label="badTitle"
            @click="$emit('mark-bad', !bad)"
          />
        </div>
      </uk-flex>
      <p class="share_text">
        {{ facts }}
      </p>
      <p
        v-if="description"
        class="share_text share_description"
        :title="description"
      >
        {{ description }}
      </p>
      <p class="share_text">
        Downloaded into your library when it is added.
      </p>
    </template>
  </uk-flex>
</template>

<script>
import {
  uploaderText, revisionText, modesText, ratingText, sizeText, dateText,
} from '@/models/DMX/gdtf/share_list';

/**
 * The library side of Add to Show: a fixture in the library, to mark
 * favourite or bad, and if it is a GDTF file its newer revision on the Share
 * and the means to remove it; or a fixture picked from the Share. The account
 * and the login are in `share.account.vue`.
 */
export default {
  name: 'SharePanel',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** 'library' or 'fixture': what was picked in the list. */
    mode: {
      type: String,
      default: 'library',
    },
    /** `{ available, user, fetched, count, error }` */
    share: {
      type: Object,
      required: true,
    },
    /**
     * The Share fixture picked, or for a library fixture its newer revision
     * on the Share; from `shareFixtures`.
     */
    fixture: {
      type: Object,
      default: null,
    },
    /** The library fixture picked: its list row. */
    entry: {
      type: Object,
      default: null,
    },
    /** Whether what was picked is marked bad. */
    bad: Boolean,
    /** Whether what was picked is marked favourite. */
    favourite: Boolean,
    busy: Boolean,
  },
  emits: ['update', 'mark-bad', 'favourite', 'remove'],
  computed: {
    /** Whether the mark buttons show, stacked in the top right corner. */
    marked() {
      if (this.mode === 'library') return !!this.entry;
      return this.mode === 'fixture' && !!this.fixture && !!this.share.user;
    },
    uploader() {
      return uploaderText(this.fixture);
    },
    facts() {
      const r = this.fixture.latest;
      return [
        revisionText(this.fixture), dateText(r), modesText(r), ratingText(r), sizeText(r.filesize),
      ].filter(Boolean).join(' · ');
    },
    description() {
      const { description } = this.fixture.latest;
      return typeof description === 'string' ? description.trim() : '';
    },
    newerText() {
      const r = this.fixture.latest;
      return [r.revision, dateText(r)].filter(Boolean).join(', ');
    },
    badTitle() {
      return this.bad ? 'Marked bad: click to unmark'
        : 'Mark as bad';
    },
    entryText() {
      const file = String(this.entry.fixture || '').split('/').pop();
      return [this.entry.revision, file].filter(Boolean).join(' · ');
    },
  },
};
</script>

<style scoped>
.share_panel {
  position: relative;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--primary-dark);
  border-radius: 4px;
}
/* Room on the right for the mark buttons, and height for all three. */
.share_panel_marked {
  padding-right: 30px;
  min-height: 66px;
}
.share_marks {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.share_marks :deep(.uikit_button.icon_only) {
  width: 18px;
  height: 18px;
  min-width: 18px;
  min-height: 18px;
}
.share_marks :deep(.uikit_button.icon_only .uikit_button_icon) {
  width: 12px !important;
  height: 12px !important;
}
/* The form's own label size: a paragraph here would otherwise take the page's. */
.share_heading {
  font-family: Roboto-Bold;
  font-size: 12px;
  color: var(--secondary-lighter);
}
.share_text {
  font-family: Roboto-Regular;
  font-size: 12px;
  line-height: 1.35;
  color: var(--secondary-lighter-alt);
}
.share_grow {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.share_buttons {
  display: flex;
  flex: none;
  gap: 8px;
}
.share_description {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
