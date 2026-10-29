/* eslint-disable no-console */
/**
 * The Wicked Lasers GDTF files Beam ships, read back the way Beam reads them:
 * a Laser geometry makes a laser, its optics and body become the laser's
 * parameters, and virtual channels become Fixed or Adjustable controls.
 *
 * Usage:
 *   npm test
 */
import fs from 'fs';
import path from 'path';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import { fixtureCategory } from '@/models/DMX/gdtf/fixture_parts';
import { laserParams } from '@/models/DMX/gdtf/laser_parts';
import { apertureOrigin, laserChannelLumens } from '@/models/DMX/generic/laser';
import movedProfile from '@/models/DMX/moved_profiles';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

const dir = path.join(process.cwd(), 'public', 'profiles', 'Wicked Lasers');
const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const read = (stem) => readGdtf(new Uint8Array(fs.readFileSync(path.join(dir, `${stem}.gdtf`))), { parseXml });
const r1 = (n) => Math.round(n * 10) / 10;

const pro = read('Wicked_Lasers@LaserCube_Pro_2.5W@Beam_1');
check('reads without problems', pro.problems, []);
check(
  'carries the body as glTF and 3DS, and a thumbnail',
  Object.keys(pro.files).sort(),
  ['models/3ds/LaserCube Pro.3ds', 'models/gltf/LaserCube Pro.glb', 'thumbnail.png'],
);
const type = pro.fixtureType;
check('a Laser geometry is a laser', fixtureCategory(type), 'Laser');
const p = laserParams(type);
check('power in watts', p.power, 2.5);
check('one RGB source: no lines', p.lines, null);
const lumens = laserChannelLumens(p);
check('lumens per colour, a third of the watts each', [lumens.red, lumens.green, lumens.blue].map((c) => Math.round(c.lumens)), [109, 404, 22]);
check('scan angle', [p.scanAngleH, p.scanAngleV], [32, 32]);
check('beam diameter in mm', r1(p.beamDiameter), 3);
check('divergence in mrad', p.divergence, 1);
check('body size from the model, mm', [p.width, p.depth, p.height].map((m) => Math.round(m * 1000)), [100, 141, 151]);
check('the beam starts at the model origin', apertureOrigin(p), { x: 0, y: 0, z: 0 });
check('every control is read', Object.keys(p.controls).length, 11);
check('a fixed control keeps its value', p.controls.dimmer, { mode: 'fixed', value: 100 });
check('a fixed switch', p.controls.shutter, { mode: 'fixed', value: true });
check('a fixed offset', p.controls.xPos, { mode: 'fixed', value: 0 });
check('an adjustable switch starts off', p.controls.mirrorX, { mode: 'adjustable', value: false });
check('no channel takes an address', type.modes[0].channels.every((c) => c.offsets === null), true);

const wideFile = read('Wicked_Lasers@LaserCube_Pro_2.5W_Wide_Angle@Beam_1');
check(
  'the wide angle carries its own body and thumbnail',
  Object.keys(wideFile.files).sort(),
  [
    'models/3ds/LaserCube Pro Wide Angle.3ds', 'models/gltf/LaserCube Pro Wide Angle.glb', 'thumbnail.png',
  ],
);
const wide = laserParams(wideFile.fixtureType);
check('the wide angle lens: 80 degrees measured, divergence 4.5', [wide.scanAngleH, wide.divergence], [80, 4.5]);
check('its lens adds depth, mm', [wide.width, wide.depth, wide.height].map((m) => Math.round(m * 1000)), [100, 170, 151]);

const ultra = read('Wicked_Lasers@LaserCube_Ultra_7.5W@Beam_1');
check(
  'the Ultra carries its body and thumbnail',
  Object.keys(ultra.files).sort(),
  ['models/3ds/LaserCube Ultra.3ds', 'models/gltf/LaserCube Ultra.glb', 'thumbnail.png'],
);
const u = laserParams(ultra.fixtureType);
check('the Ultra is 7.5 W, its diodes added up', u.power, 7.5);
check('one Laser geometry per diode', u.lines, [{ nm: 638, watts: 1.5 }, { nm: 525, watts: 2 }, { nm: 455, watts: 4 }]);
const ul = laserChannelLumens(u);
check('each diode lights its channel at its wavelength', [ul.red.nm, ul.green.nm, ul.blue.nm], [638, 525, 455]);
check('mostly green in lumens', [ul.red, ul.green, ul.blue].map((c) => Math.round(c.lumens)), [196, 1084, 131]);
check('its body, mm', [u.width, u.depth, u.height].map((m) => Math.round(m * 1000)), [202, 196, 199]);
check('its beam starts at the model origin', apertureOrigin(u), { x: 0, y: 0, z: 0 });
const ultraWide = laserParams(read('Wicked_Lasers@LaserCube_Ultra_7.5W_Wide_Angle@Beam_1').fixtureType);
check('the Ultra wide angle lens adds depth, mm', Math.round(ultraWide.depth * 1000), 225);
check('and opens the Ultra to 92.5 degrees', [ultraWide.scanAngleH, ultraWide.divergence], [92.5, 4.5]);
check('the Ultra: 37 degrees, 4 mm, 1 mrad', [u.scanAngleH, Math.round(u.beamDiameter * 10) / 10, u.divergence], [37, 4, 1]);

check(
  'an old project finds the GDTF',
  movedProfile('wicked-lasers', 'LaserCube Pro 2.5W'),
  { manufacturer: 'Wicked Lasers', model: 'Wicked_Lasers@LaserCube_Pro_2.5W@Beam_1' },
);
check('every moved key names a shipped file', ['LaserCube Pro 2.5W', 'LaserCube Pro 2.5W Wide Angle',
  'LaserCube 7.5W Ultra', 'LaserCube 7.5W Ultra Wide Angle']
  .every((m) => fs.existsSync(path.join(dir, `${movedProfile('wicked-lasers', m).model}.gdtf`))), true);
check('other profiles stay put', movedProfile('martin', 'mac-aura'), { manufacturer: 'martin', model: 'mac-aura' });

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
