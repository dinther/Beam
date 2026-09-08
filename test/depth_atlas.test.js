/* eslint-disable no-console */
/**
 * Which tiles of a depth atlas are redrawn, and what gets cleared.
 *
 * Every fixture with a depth tile redraws the whole scene into it, so a rig of
 * six projectors is six full scene passes a frame -- to reproduce, in a
 * bolted-down rig in a still room, the identical image each time. The atlas
 * skips a tile whose inputs have not moved, which is only safe if two things
 * hold, and neither is visible by eye:
 *
 *   - The key notices everything a tile depends on. A missed input leaves a
 *     stale tile, which reads as a beam passing through a wall or cut against
 *     open air -- and it will be blamed on the shader.
 *   - The clear is scissored to the tile being drawn. A full-atlas clear makes
 *     the whole thing all-or-nothing, because every tile it kept would have
 *     been blanked to the far plane first.
 *
 * The camera half of the key is the part worth pinning hardest: a projector's
 * zoom and shift are DMX-drivable and rewrite the projection matrix while the
 * lens does not move a millimetre, so hashing the camera's world matrix alone
 * would hold a stale tile through a zoom.
 *
 * Usage:
 *   npm test
 */
import * as THREE from 'three';
import { DepthAtlas, sceneDepthKey, tileDepthKey } from '@/plugins/visualizer/projector_depth';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * A renderer that draws nothing and writes down what it was asked to do.
 *
 * The scissor box is recorded **at the moment of each clear**, which is the
 * whole question: a clear taken with the scissor covering the atlas wipes the
 * tiles that were being kept.
 */
function fakeRenderer() {
  const calls = { clears: [], renders: [] };
  let scissor = null;
  let scissorTest = false;
  return {
    calls,
    autoClear: true,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getClearAlpha: () => 1,
    getClearColor: (target) => target,
    setClearColor: () => {},
    setScissorTest: (on) => { scissorTest = on; },
    setScissor: (x, y, w, h) => {
      scissor = {
        x, y, w, h,
      };
    },
    setViewport: () => {},
    getSize: (target) => target.set(1920, 1080),
    clear: () => { calls.clears.push({ scissorTest, scissor }); },
    render: (scene, camera) => { calls.renders.push(camera.uuid); },
  };
}

/** Two shadow-casting boxes, which is all the pass looks at. */
function makeScene() {
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  wall.castShadow = true;
  const truss = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  truss.castShadow = true;
  truss.position.set(4, 0, 0);
  scene.add(wall, truss);
  return { scene, wall };
}

function makeProjections(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 100);
    camera.position.set(i * 2, -6, 3);
    camera.updateMatrixWorld(true);
    out.push({ camera });
  }
  return out;
}

/** Fresh atlas, fresh renderer, and one pass already drawn. */
function primed(count = 4) {
  const atlas = new DepthAtlas({
    columns: 2, rows: 2, tile: 64, near: 0.5, far: 100,
  });
  const { scene, wall } = makeScene();
  const projections = makeProjections(count);
  const renderer = fakeRenderer();
  const drawn = atlas.render(renderer, scene, projections);
  return {
    atlas, scene, wall, projections, renderer, drawn,
  };
}

console.log('\n-- the first pass owes every tile --');

{
  const { drawn, renderer } = primed(4);
  check('every tile drawn', drawn, 4);
  check('one scene pass each', renderer.calls.renders.length, 4);
}

console.log('\n-- and a still rig owes none --');

{
  const {
    atlas, scene, projections, renderer,
  } = primed(4);
  renderer.calls.renders.length = 0;
  renderer.calls.clears.length = 0;
  check('nothing redrawn', atlas.render(renderer, scene, projections), 0);
  check('no scene pass at all', renderer.calls.renders.length, 0);
  // The clear is the dangerous half: a tile wiped and not redrawn is worse
  // than one redrawn needlessly, because it answers the far plane everywhere.
  check('and nothing cleared', renderer.calls.clears.length, 0);
}

console.log('\n-- a tile is cleared inside its own scissor, not across the atlas --');

{
  const { renderer } = primed(4);
  check('one clear per tile drawn', renderer.calls.clears.length, 4);
  check('every clear scissored', renderer.calls.clears.every((c) => c.scissorTest), true);
  const boxes = renderer.calls.clears.map((c) => `${c.scissor.x},${c.scissor.y}`);
  check('each to a different tile', new Set(boxes).size, 4);
  check('and to one tile, not the atlas', renderer.calls.clears[0].scissor.w, 64);
}

console.log('\n-- moving one fixture costs one tile, not the rig --');

{
  const {
    atlas, scene, projections, renderer,
  } = primed(4);
  renderer.calls.renders.length = 0;
  renderer.calls.clears.length = 0;
  projections[2].camera.position.x += 1;
  projections[2].camera.updateMatrixWorld(true);
  check('one tile redrawn', atlas.render(renderer, scene, projections), 1);
  check('and it is that fixture', renderer.calls.renders[0], projections[2].camera.uuid);
  check('one clear, on its tile', renderer.calls.clears.length, 1);
  // Slot 2 of a 2x2 atlas of 64 px tiles is the bottom-left of the top row.
  check('at that slot', `${renderer.calls.clears[0].scissor.x},${renderer.calls.clears[0].scissor.y}`, '0,64');
}

console.log('\n-- a zoom moves no camera and must still redraw --');

{
  const {
    atlas, scene, projections, renderer,
  } = primed(4);
  renderer.calls.renders.length = 0;
  // What `Projector.projection()` does every frame when a console drives zoom
  // or shift: the frustum is rewritten, the lens stays exactly where it is.
  projections[1].camera.projectionMatrix.makePerspective(-0.4, 0.4, 0.25, -0.25, 0.5, 100);
  check('the zoomed tile redrawn', atlas.render(renderer, scene, projections), 1);
  check('and it is that fixture', renderer.calls.renders[0], projections[1].camera.uuid);
}

console.log('\n-- geometry moving is everybody\'s business --');

{
  const {
    atlas, scene, wall, projections, renderer,
  } = primed(4);
  renderer.calls.renders.length = 0;
  wall.position.z += 2;
  wall.updateMatrixWorld(true);
  check('every tile redrawn', atlas.render(renderer, scene, projections), 4);
}

console.log('\n-- and the scene is walked once, not once per tile --');

{
  const { scene, projections } = primed(4);
  let visits = 0;
  const counted = { ...scene, traverse: (fn) => { visits += 1; scene.traverse(fn); } };
  sceneDepthKey(counted);
  check('one traversal', visits, 1);
  // Which is what makes the per-tile key affordable: the expensive half is
  // shared, and only the camera is mixed in per fixture.
  const sceneKey = sceneDepthKey(scene);
  const a = tileDepthKey(sceneKey, projections[0].camera);
  const b = tileDepthKey(sceneKey, projections[1].camera);
  check('two lenses, two keys', a === b, false);
  check('and a lens is its own key twice', tileDepthKey(sceneKey, projections[0].camera), a);
}

console.log('\n-- a tile nobody owns is not left answering for the next fixture --');

{
  const {
    atlas, scene, projections, renderer,
  } = primed(4);
  // Three projectors left of four: the fourth tile's key must go with it, or a
  // fixture landing in that slot later inherits the old one and never draws.
  atlas.render(renderer, scene, projections.slice(0, 3));
  check('keys trimmed to what is owned', atlas.tileKeys.length, 3);
  renderer.calls.renders.length = 0;
  check('the returning fixture draws', atlas.render(renderer, scene, projections), 1);
  check('into its own slot', renderer.calls.renders[0], projections[3].camera.uuid);
}

console.log('\n-- more fixtures than slots is a cap, not a crash --');

{
  const atlas = new DepthAtlas({
    columns: 2, rows: 1, tile: 64, near: 0.5, far: 100,
  });
  const { scene } = makeScene();
  const renderer = fakeRenderer();
  check('drawn up to the cap', atlas.render(renderer, scene, makeProjections(5)), 2);
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
if (failures) process.exit(1);
