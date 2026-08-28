/* eslint-disable no-console */
/**
 * The transform every placeable scene item shares.
 *
 * `Fixture`, `Structure` and `SceneObject` used to write their own per-axis
 * accessors -- twelve each in the first two, none at all in the third -- and
 * they had drifted: `Fixture.rotX` accepted a non-finite angle where
 * `Structure.writeAxis` refused one, so a bad keystroke could blank a fixture
 * by a route already closed for structures. They now share one implementation
 * from `scene_item.transform.js`, and each supplies only the step that differs:
 * a fixture pushes to its 3D model, a structure carries its members, an object
 * rewrites its instance matrix.
 *
 * What is checked here is the part that is easy to get wrong when hoisting
 * behaviour into a base: that the shared accessors still read and write the
 * same units, that the per-kind step still fires, and that the guard which
 * rejects a non-finite value is now in force for all three rather than two.
 *
 * Usage:
 *   npm test
 */
import Controls from '@/plugins/visualizer/controls';
import Fixture from '@/models/DMX/fixture.model';
import Structure from '@/models/DMX/structure.model';
import SceneObject from '@/models/DMX/object.model';
import { SCENE_ITEM_KINDS } from '@/models/DMX/scene_item';

// The gizmo is detached around every axis write so its cached handles cannot
// be left where the item no longer is. It needs a live viewport to do that,
// which there is none of here -- and it is not what this test is about. Stubbed
// rather than emulated, the same bargain `bench/shim.cjs` makes for the browser
// globals the model layer touches at import time.
Controls.detach = () => {};
Controls.attach = () => {};

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Degrees a right angle is worth, to keep the float comparisons exact. */
const RIGHT_ANGLE = 90;

/**
 * Runs the shared contract against one kind.
 *
 * @param {String} label
 * @param {Object} item a constructed scene item
 * @param {String} kind the kind it should report
 */
function checkContract(label, item, kind) {
  console.log(`\n${label}`);
  check('reports its kind', item.kind, kind);
  check('has a uid', typeof item.uid === 'number' || typeof item.uid === 'string', true);

  // Per-axis position, in metres.
  item.posX = 2.5;
  check('posX round-trips', item.posX, 2.5);
  check('posX reached position', item.position.x, 2.5);

  // Per-axis rotation: degrees on the outside, radians within.
  item.rotZ = RIGHT_ANGLE;
  check('rotZ round-trips in degrees', Math.round(item.rotZ), RIGHT_ANGLE);
  check('rotZ stored as radians', Math.round(item.rotationRad.z * 1000) / 1000, 1.571);

  // The guard that only two of the three used to have.
  item.posY = 4;
  item.posY = Number.NaN;
  check('a NaN axis is refused, not stored', item.posY, 4);
  item.rotX = Number.NaN;
  check('a NaN angle is refused, not stored', Number.isFinite(item.rotationRad.x), true);
  item.posZ = Number.POSITIVE_INFINITY;
  check('an infinite axis is refused', Number.isFinite(item.posZ), true);

  // The per-kind step has to still run, or the item moves in the model and
  // stays put on screen -- which is the failure a shared base risks causing.
  let applied = 0;
  const original = item.applyTransform.bind(item);
  item.applyTransform = (field) => { applied += 1; return original(field); };
  item.posX = 3;
  check('the per-kind apply step fired', applied, 1);
  item.rotationRad = { x: 0, y: 0, z: 0 };
  check('rotationRad also applies', applied, 2);
}

// `isStub` is the constructor's own escape hatch for a fixture with no profile
// behind it, which is what this needs: the transform is the subject, and a real
// profile would drag in a renderer and a patch. A stub skips the branch that
// builds the transform, though -- true before this refactor as after it -- so
// the two fields are seeded here rather than pretending the class does it.
const stubFixture = new Fixture({ isStub: true });
stubFixture._position = { x: 0, y: 0, z: 0 };
stubFixture._rotation = { x: 0, y: 0, z: 0 };
checkContract('Fixture', stubFixture, SCENE_ITEM_KINDS.FIXTURE);
checkContract('Structure', new Structure({ name: 'test' }), SCENE_ITEM_KINDS.STRUCTURE);
checkContract('SceneObject', new SceneObject({ name: 'test' }), SCENE_ITEM_KINDS.OBJECT);

console.log('\nuids are unique across kinds');
const a = new Structure({ name: 'a' });
const b = new SceneObject({ name: 'b' });
check('a structure and an object never share a uid', a.uid === b.uid, false);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
