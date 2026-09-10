import EventBus from './eventbus';

/**
 * @file Asks the user a yes/no question and waits for the answer.
 *
 *     if (!await confirm({ title, message })) return;
 *
 * The popup lives at the app root (`popup.confirm.vue`, hosted by
 * `app.activity.vue`), so any widget or model can ask without mounting a popup
 * of its own. Anything but "yes" -- cancel, the close cross, no host to ask --
 * answers false: an unanswered question is never consent.
 */

/**
 * @public
 * @param {Object} question
 * @param {String} question.title what is being decided
 * @param {String} question.message the question
 * @param {String} [question.detail] what it will cost
 * @param {String} [question.yes] the yes button's label
 * @param {String} [question.no] the no button's label
 * @returns {Promise<Boolean>}
 */
export default function confirm({
  title, message, detail = '', yes = 'yes', no = 'no',
}) {
  return new Promise((resolve) => {
    // Nobody to ask means nobody said yes.
    if (!EventBus.all.has('confirm')) {
      resolve(false);
      return;
    }
    EventBus.emit('confirm', {
      title, message, detail, yes, no, resolve,
    });
  });
}
