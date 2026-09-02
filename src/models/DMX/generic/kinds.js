/**
 * @file Which generic builder made a profile.
 *
 * Coarser than any one builder's own shapes: `BAR_SHAPES` says whether a bar is
 * drawn as a line or a rectangle, and both are built by the same function from
 * the same parameters. This says *which function*, which is the question the
 * create dialog and `Show.createGeneratedProfile` have to agree on.
 *
 * Its own file so that neither of them imports the other's builder to find out.
 */

/**
 * @constant {Object}
 * @enum {String}
 */
export const GENERIC_KINDS = {
  /** An LED bar or panel -- see `led_bar.js`. */
  BAR: 'bar',
  /** A projector -- see `projector.js`. */
  PROJECTOR: 'projector',
  /** A display: a surface showing a video connector -- see `display.js`. */
  DISPLAY: 'display',
};

export default GENERIC_KINDS;

/**
 * The icon that stands for a fixture in a list or a widget header.
 *
 * Here rather than in either view, because two of them ask the same question
 * and an icon that disagrees between the patch bay and the widget above it
 * reads as two different fixtures.
 *
 * @public
 * @param {Object} fixture
 * @returns {String} an icon name from the uikit set
 */
export function fixtureIcon(fixture) {
  if (!fixture) return 'movinghead';
  if (fixture.deviceKind === GENERIC_KINDS.PROJECTOR) return 'projector';
  if (fixture.isBar) return 'ledbar';
  return 'movinghead';
}
