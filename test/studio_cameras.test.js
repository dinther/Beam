/* eslint-disable no-console */
/**
 * A camera is placed from the view you are already looking at.
 *
 * The viewport is the viewfinder: `position` and `target` come straight from
 * what `OrbitControls` is holding, so a stored camera restores the view exactly
 * rather than approximately. This pins the naming, the ids and the fallbacks --
 * the parts a later dolly move will be built on top of.
 *
 * Usage:
 *   npm test
 */
import Studio from '@/models/DMX/studio';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const view = {
  position: { x: 4, y: -6, z: 1.7 },
  target: { x: 0, y: 2, z: 5 },
  fov: 35,
};

console.log('\n-- placed from the viewport --');
{
  const camera = Studio.addCamera(view);
  check('keeps the position', camera.position, view.position);
  check('and the look-at point', camera.target, view.target);
  check('and the lens', camera.fov, 35);
  check('named from one', camera.name, 'Camera 1');
  check('and becomes live', Studio.state.activeCameraId, camera.id);
  check('the editor camera is still there', Studio.state.cameras[0].id, Studio.SCENE_CAMERA_ID);
}

console.log('\n-- a copy, not a reference --');
{
  const source = { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, fov: 45 };
  const camera = Studio.addCamera(source);
  source.position.x = 99;
  check('moving the source leaves the camera alone', camera.position.x, 1);
}

console.log('\n-- names and ids --');
{
  const third = Studio.addCamera(view);
  check('numbered past what is taken', third.name, 'Camera 3');
  const ids = new Set(Studio.state.cameras.map((camera) => camera.id));
  check('every id is distinct', ids.size, Studio.state.cameras.length);

  // Renaming one out of the sequence must not make the next a duplicate.
  third.name = 'Wide on the truss';
  check('the next takes the free number', Studio.addCamera(view).name, 'Camera 3');
}

console.log('\n-- asked with nothing --');
{
  const live = Studio.activeCamera;
  const camera = Studio.addCamera(null);
  check('falls back to the live camera', camera.position, live.position);
  check('rather than the origin', camera.target, live.target);
  check('and keeps a usable lens', camera.fov > 0, true);
}

console.log('\n-- a lens outside the limits --');
{
  const camera = Studio.addCamera({ ...view, fov: 500 });
  check('clamped', camera.fov, Studio.LIMITS.maxFov);
}

console.log('\n-- deleting --');
{
  const camera = Studio.addCamera(view);
  const before = Studio.state.cameras.length;
  check('the live one goes', Studio.removeCamera(camera.id), true);
  check('the list is shorter', Studio.state.cameras.length, before - 1);
  check('and the editor camera takes over', Studio.state.activeCameraId, Studio.SCENE_CAMERA_ID);
  check('an id that names nothing', Studio.removeCamera('camera:nonesuch'), false);
  check('the editor camera cannot go', Studio.removeCamera(Studio.SCENE_CAMERA_ID), false);
  check('and is still there', Studio.state.cameras[0].id, Studio.SCENE_CAMERA_ID);
}

console.log('\n-- written to the show, and read back --');
{
  Studio.loadCameras([]);
  const wide = Studio.addCamera({ ...view, fov: 22 });
  Studio.setSelectedName('Wide on the truss');
  Studio.addCamera({
    position: { x: 1, y: 2, z: 3 }, target: { x: 4, y: 5, z: 6 }, fov: 60,
  });
  Studio.setSelectedName('Tight on the tower');

  const written = Studio.showData;
  // The editor camera IS written now, flagged, and it comes first. It is the
  // view the project was left at, and unlike a placed camera it has nowhere
  // else to live -- so a project that did not carry it reopened looking
  // somewhere else. This assertion used to read "the editor camera is not
  // written"; the behaviour changed deliberately.
  check('the editor camera is written too', written.length, 3);
  check('and is flagged as the editor', written[0].editor, true);
  check('while the placed ones are not', written[1].editor, undefined);
  check('names survive', written.slice(1).map((c) => c.name), ['Wide on the truss', 'Tight on the tower']);
  check('so does the lens', written[1].fov, 22);
  check('and the view', written[2].target, { x: 4, y: 5, z: 6 });
  check('ids are not stored', Object.keys(written[1]).includes('id'), false);

  // What loading another show does.
  Studio.loadCameras(written);
  const back = Studio.state.cameras;
  check('the editor camera is kept', back[0].id, Studio.SCENE_CAMERA_ID);
  check('two cameras restored', back.length, 3);
  check('with their names', back[2].name, 'Tight on the tower');
  check('and their views', back[1].position, wide.position);
  check('fresh ids', back[1].id === wide.id, false);
  check('the editor camera is live again', Studio.state.activeCameraId, Studio.SCENE_CAMERA_ID);
  check('and loading reports it found one', Studio.loadCameras(written), true);
  check('a file without one reports so', Studio.loadCameras([{ name: 'X', fov: 40 }]), false);
}

console.log('\n-- the lock --');
{
  Studio.loadCameras([]);
  const shot = Studio.addCamera({ ...view, fov: 30 });
  check('starts unlocked', Studio.isCameraLocked(shot.id), false);
  check('toggles on', Studio.toggleCameraLock(shot.id), true);
  check('and reads back', Studio.isCameraLocked(shot.id), true);
  const kept = Studio.showData;
  check('travels with the show', kept[1].locked, true);
  Studio.loadCameras(kept);
  check('and comes back locked', Studio.state.cameras[1].locked, true);
  check('toggles off again', Studio.toggleCameraLock(Studio.state.cameras[1].id), false);
}

console.log('\n-- selecting is not going --');
{
  Studio.loadCameras([]);
  const one = Studio.addCamera({ ...view, fov: 30 });
  const two = Studio.addCamera({ ...view, fov: 40 });
  Studio.cutToCamera(one.id);
  Studio.selectCamera(two.id);
  check('selecting changes what is edited', Studio.state.selectedCameraId, two.id);
  check('but not what is live', Studio.state.activeCameraId, one.id);
  Studio.cutToCamera(two.id);
  check('cutting changes what is live', Studio.state.activeCameraId, two.id);
  check('without asking for a fly', Studio.state.flyRequested, false);
  Studio.flyToCamera(one.id);
  check('flying asks for one', Studio.state.flyRequested, true);
}

console.log('\n-- a show written before cameras existed --');
{
  Studio.loadCameras(undefined);
  check('leaves only the editor camera', Studio.state.cameras.length, 1);
  check('and it is the editor camera', Studio.state.cameras[0].id, Studio.SCENE_CAMERA_ID);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
