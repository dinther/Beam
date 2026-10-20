<template>
  <uk-flex
    col
    :gap="6"
    class="share_account"
  >
    <template v-if="share.user">
      <p class="share_text">
        GDTF Share: {{ share.user }} · {{ listText }}
      </p>
      <uk-flex
        :gap="8"
        center-h
      >
        <p class="share_hint">
          {{ searching ? '' : 'Type in the search to find fixtures on it.' }}
        </p>
        <uk-button
          label="refresh list"
          :disabled="busy"
          @click="$emit('refresh')"
        />
        <uk-button
          label="log out"
          :disabled="busy"
          @click="$emit('log-out')"
        />
      </uk-flex>
    </template>

    <uk-flex
      v-else-if="!open"
      :gap="8"
      center-h
    >
      <p class="share_text share_grow">
        GDTF Share: not logged in
      </p>
      <uk-button
        label="log in"
        :disabled="busy"
        @click="openLogIn"
      />
    </uk-flex>

    <template v-else>
      <p class="share_text">
        Your account at gdtf-share.com, checked with the Share and kept on this
        computer encrypted by Windows.
      </p>
      <p
        v-if="!share.available"
        class="share_error"
      >
        This system cannot store the account encrypted, so it cannot be kept.
      </p>
      <uk-flex :gap="8">
        <uk-txt-input
          v-model="user"
          label="User"
          style="flex: 1"
          auto-update
        />
        <uk-txt-input
          v-model="password"
          label="Password"
          style="flex: 1"
          password
          auto-update
        />
      </uk-flex>
      <uk-flex
        :gap="8"
        class="share_end"
      >
        <uk-button
          label="cancel"
          :disabled="busy"
          @click="open = false"
        />
        <uk-button
          label="log in"
          :disabled="busy || !user || !password || !share.available"
          @click="logIn"
        />
      </uk-flex>
    </template>

    <p
      v-if="share.error"
      class="share_error"
    >
      {{ share.error }}
    </p>
  </uk-flex>
</template>

<script>
/**
 * The GDTF Share account under Add to Show's fixture list: who is logged in
 * and how old the list is, with refresh and log out, or the login. Shown
 * whatever is selected, since the account belongs to no one fixture.
 */
export default {
  name: 'ShareAccount',
  compatConfig: {
    MODE: 3,
  },
  props: {
    /** `{ available, user, fetched, count, error }` */
    share: {
      type: Object,
      required: true,
    },
    /** Whether the list's search has words in it, which is when the Share is searched. */
    searching: Boolean,
    busy: Boolean,
  },
  emits: ['log-in', 'log-out', 'refresh'],
  data() {
    return { open: false, user: '', password: '' };
  },
  computed: {
    listText() {
      if (!this.share.fetched) return 'no list yet';
      return `${this.share.count} fixtures, list from ${new Date(this.share.fetched).toLocaleDateString()}`;
    },
  },
  watch: {
    // Closes the form once the login it sent has been accepted.
    'share.user': function closeOnLogIn(user) {
      if (user) this.open = false;
    },
  },
  methods: {
    /** Shows the login fields. @public */
    openLogIn() {
      this.open = true;
    },
    logIn() {
      this.$emit('log-in', this.user.trim(), this.password);
      this.password = '';
    },
  },
};
</script>

<style scoped>
.share_account {
  padding: 8px;
  border-top: 1px solid var(--primary-dark);
  border-right: 1px solid var(--primary-dark);
  /* The list's width: a long user name or error wraps instead of widening the column. */
  width: 380px;
  box-sizing: border-box;
}
.share_text {
  font-family: Roboto-Regular;
  font-size: 12px;
  line-height: 1.35;
  color: var(--secondary-lighter-alt);
  overflow-wrap: anywhere;
}
.share_hint {
  flex: 1;
  min-width: 0;
  font-family: Roboto-Regular;
  font-size: 11px;
  color: var(--secondary-light-alt);
}
.share_grow {
  flex: 1;
  min-width: 0;
}
.share_end {
  justify-content: flex-end;
}
.share_error {
  font-family: Roboto-Regular;
  font-size: 12px;
  color: var(--accent-red);
  overflow-wrap: anywhere;
}
</style>
