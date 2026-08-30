/* eslint-disable no-console */
/**
 * The universe numbers a MadMapper layout carries.
 *
 * Beam's address space is an offset from zero. Art-Net counts from zero too,
 * so an export aimed at an Art-Net project writes the number the patch bay
 * shows. E1.31 counts from one and MadMapper follows it, so an export aimed at
 * an sACN project has to write one more -- and getting that wrong puts every
 * fixture in the show a universe out, which looks like an addressing bug
 * anywhere but here.
 *
 * The complement of this is `sacn.test.js`, which pins the same step being
 * taken back off an inbound packet. The two have to agree or a show exported
 * from Beam will not read back into it.
 *
 * Usage:
 *   npm test
 */
import {
  buildMadMapperLayout,
  universeOffset,
  PROJECTIONS,
  PROTOCOLS,
} from '@/models/DMX/generic/madmapper_layout';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** The smallest profile that yields one light island: three emitters. */
const RGB = {
  availableChannels: {
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
    Green: { capability: { type: 'ColorIntensity', color: 'Green' } },
    Blue: { capability: { type: 'ColorIntensity', color: 'Blue' } },
  },
  modes: [{ name: 'RGB', channels: ['Red', 'Green', 'Blue'] }],
};

/**
 * A fixture as the layout reads one: a position, a rotation, an address and a
 * profile. Not a `Fixture` instance -- the export never asks for anything an
 * instance adds, and building one would drag the whole show model in.
 *
 * @param {Number} address absolute first channel, counted from zero
 * @returns {Object}
 */
function fixtureAt(address) {
  return {
    id: `f${address}`,
    name: `Head ${address}`,
    address,
    channels: [0, 1, 2],
    position: { x: 0, y: 0, z: 0 },
    rotationRad: { x: 0, y: 0, z: 0 },
    OFLData: RGB,
    mode: RGB.modes[0],
    alignmentPixelSize: 0,
  };
}

/**
 * The universes an export wrote, in the order they appear.
 *
 * Read back out of the element ids rather than out of anything this test
 * built, so what is checked is the file MadMapper would actually be handed.
 *
 * @param {String} svg
 * @returns {Array<Number>}
 */
function universesIn(svg) {
  return [...svg.matchAll(/__UN__(\d+)__CH__(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The channels an export wrote, which the protocol must not touch.
 *
 * @param {String} svg
 * @returns {Array<Number>}
 */
function channelsIn(svg) {
  return [...svg.matchAll(/__UN__(\d+)__CH__(\d+)/g)].map((m) => Number(m[2]));
}

const build = (protocol) => buildMadMapperLayout({
  // Universe 0 channel 1, universe 0 channel 121, and universe 3 channel 1.
  fixtures: [fixtureAt(0), fixtureAt(120), fixtureAt(3 * 512)],
  projection: PROJECTIONS.FRONT,
  definitionName: () => 'Test - RGB',
  ...(protocol === undefined ? {} : { protocol }),
});

const artnet = build(PROTOCOLS.ARTNET);
const sacn = build(PROTOCOLS.SACN);
const fallback = build(undefined);

check('offset, Art-Net', universeOffset(PROTOCOLS.ARTNET), 0);
check('offset, sACN', universeOffset(PROTOCOLS.SACN), 1);
// Anything unrecognised has to behave as Art-Net did before there was a
// choice, or an old caller silently moves every fixture a universe.
check('offset, unknown protocol', universeOffset('nonsense'), 0);

check('Art-Net universes', universesIn(artnet).join(), '0,0,3');
check('sACN universes', universesIn(sacn).join(), '1,1,4');
check('default is Art-Net', universesIn(fallback).join(), '0,0,3');

// The channel is a position inside a universe, not an address, so it is the
// same number on either wire. A protocol that shifted it would be shifting the
// fixture as well as renaming its universe.
check('Art-Net channels', channelsIn(artnet).join(), '1,121,1');
check('sACN channels', channelsIn(sacn).join(), '1,121,1');

// Nothing else about the file may move: the same rig, drawn the same way.
const blind = (svg) => svg.replace(/__UN__\d+/g, '__UN__');
check('geometry is untouched', blind(artnet) === blind(sacn), true);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
