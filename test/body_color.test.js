/* eslint-disable no-console */
/**
 * A created fixture's body colour travels from the create dialog's params to
 * the thing drawn in the scene.
 *
 * The colour is part of the definition, like the size: each kind's builder
 * keeps it with the rest of its parameters, and each renderer's finish turns it
 * into a material -- or, for bars, which are all one instanced mesh, into an
 * instance colour. A definition written before colours existed says nothing and
 * gets its kind's old colour, so no show changes when it is reopened.
 *
 * Usage:
 *   npm test
 */
import * as THREE from 'three';
import { FIXTURE_KINDS } from '@/models/DMX/generic/fixture_kind';
import BodyFinish, { hexColour } from '@/plugins/visualizer/body_finish';
import LEDField from '@/plugins/visualizer/led_field';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const srgbHex = (color) => `#${color.getHexString(THREE.SRGBColorSpace)}`;

console.log('\n-- every kind keeps its body colour in the definition --');
FIXTURE_KINDS.forEach((kind) => {
  check(`${kind.label}: has a default`, !!hexColour(kind.defaults.bodyColor), true);
  const plain = kind.paramsOf(kind.buildProfile({}));
  check(`${kind.label}: a new one wears the default`, plain.bodyColor, kind.defaults.bodyColor);
  const white = kind.paramsOf(kind.buildProfile({ bodyColor: '#f0f0f0' }));
  check(`${kind.label}: a chosen colour is kept`, white.bodyColor, '#f0f0f0');
});

console.log('\n-- the finish --');
const finish = new BodyFinish({
  colour: '#a8aeb4', roughness: 0.9, metalness: 0.05, lift: 0.72,
});
check('the default colour, when nothing is said', srgbHex(finish.material(undefined).color), '#a8aeb4');
check('and when something unusable is said', srgbHex(finish.material('grey').color), '#a8aeb4');
check('a chosen colour', srgbHex(finish.material('#FF0000').color), '#ff0000');
const red = finish.material('#ff0000');
check('one material per colour, shared', finish.material('#FF0000'), red);
check('different colours, different materials', finish.material('#ff0000') !== finish.material('#00ff00'), true);
// The projector's floor used to be the fixed 0x767d84; from the lift it lands
// within a couple of steps of that, per channel.
const srgb = (color) => color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
const floor = srgb(finish.material(undefined).emissive);
const was = srgb(new THREE.Color(0x767d84));
const step = Math.max(...['r', 'g', 'b'].map((c) => Math.abs(floor[c] - was[c]) * 255));
check('the default projector looks as it did', step <= 3, true);
const matte = new BodyFinish({ colour: '#ffffff', roughness: 1, metalness: 0 });
check('no lift, no floor', matte.material(undefined).emissive.getHex(), 0);

console.log('\n-- bars: one mesh, a colour per body --');
const scene = new THREE.Scene();
LEDField.init({ scene, maxBars: 4, maxLeds: 0 });
const mesh = scene.children.find((child) => child.isInstancedMesh);
check('the bodies are one instanced mesh', !!mesh, true);
const at = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
const size = { length: 1, width: 0.02, height: 0.01 };
LEDField.addBody({ ...at, ...size });
LEDField.addBody({ ...at, ...size, color: '#ffffff' });
const colourAt = (i) => {
  const colour = new THREE.Color();
  mesh.getColorAt(i, colour);
  return srgbHex(colour);
};
const bar = FIXTURE_KINDS.find((kind) => kind.paramsKey === 'bar');
check('a bar that says nothing is the old dark grey', colourAt(0), bar.defaults.bodyColor);
check('a white bar is white', colourAt(1), '#ffffff');
check('the material leaves the colour to the instance', mesh.material.color.getHex(), 0xffffff);

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
