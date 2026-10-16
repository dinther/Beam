/* eslint-disable no-console */
/**
 * A structure becomes a group in the exported layout.
 *
 * MadMapper reads the SVG's `<g>` elements as its own groups, so a structure
 * that does not become one leaves its fixtures loose in the tree with nothing
 * tying them together -- which is the whole reason for having made a structure.
 *
 * Usage:
 *   npm test
 */
import fs from 'node:fs';
import {
  buildMadMapperLayout, PROJECTIONS, PROTOCOLS, SQUARES,
} from '@/models/DMX/generic/madmapper_layout';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
}

/**
 * A moving head: colour *and* movement, so it comes apart into islands.
 *
 * A fixture that splits carries an `owner` -- its own name -- because when it
 * belongs to nothing else it *is* the outermost thing in the tree. Inside a
 * structure it is not, and preferring the owner regardless would put nine
 * heads in nine groups and the structure's name nowhere.
 */
const MOVER = {
  availableChannels: {
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
    Green: { capability: { type: 'ColorIntensity', color: 'Green' } },
    Blue: { capability: { type: 'ColorIntensity', color: 'Blue' } },
    Pan: { capability: { type: 'Pan', angleStart: '0deg', angleEnd: '540deg' } },
    Tilt: { capability: { type: 'Tilt', angleStart: '0deg', angleEnd: '270deg' } },
  },
  modes: [{ name: 'Basic', channels: ['Red', 'Green', 'Blue', 'Pan', 'Tilt'] }],
};

const RGB = {
  availableChannels: {
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
    Green: { capability: { type: 'ColorIntensity', color: 'Green' } },
    Blue: { capability: { type: 'ColorIntensity', color: 'Blue' } },
  },
  modes: [{ name: 'RGB', channels: ['Red', 'Green', 'Blue'] }],
};

/** A fixture as the layout reads one. */
function at(address, x) {
  return {
    id: `f${address}`,
    name: `Head ${address}`,
    address,
    channels: [0, 1, 2],
    position: { x, y: 0, z: 0 },
    rotationRad: { x: 0, y: 0, z: 0 },
    OFLData: RGB,
    mode: RGB.modes[0],
    alignmentPixelSize: 0,
  };
}

/** The `<g id>` names an export wrote, in order. */
function groupsIn(svg) {
  return [...String(svg).matchAll(/<g id="([^"]+)"/g)].map((m) => m[1]);
}

const layout = (fixtures, groups) => buildMadMapperLayout({
  fixtures,
  groups,
  projection: PROJECTIONS.FRONT,
  definitionName: () => 'beatline - Head',
  protocol: PROTOCOLS.ARTNET,
});

console.log('\n-- a structure becomes a group --');
{
  const a = at(0, 0);
  const b = at(3, 1);
  const structure = {
    id: 1, name: 'Truss A', members: [a, b], mappings: [],
  };
  const ids = groupsIn(layout([a, b], [structure]));
  check('the structure is named in the svg', ids.includes('Truss A'), true);
  check('and it is the only group', ids.length, 1);
}

console.log('\n-- loose fixtures sit apart from it --');
{
  const a = at(0, 0);
  const b = at(3, 1);
  const loose = at(6, 5);
  const structure = {
    id: 1, name: 'Truss A', members: [a, b], mappings: [],
  };
  const ids = groupsIn(layout([a, b, loose], [structure]));
  check('two groups', ids.length, 2);
  check('one of them the structure', ids.includes('Truss A'), true);
}

console.log('\n-- two structures are two groups --');
{
  const a = at(0, 0);
  const b = at(3, 1);
  const left = {
    id: 1, name: 'Truss A', members: [a], mappings: [],
  };
  const right = {
    id: 2, name: 'Truss B', members: [b], mappings: [],
  };
  const ids = groupsIn(layout([a, b], [left, right]));
  check('both named', ids.includes('Truss A') && ids.includes('Truss B'), true);
}

console.log('\n-- a structure of moving heads is still one group --');
{
  const head = (address, x) => ({
    id: `m${address}`,
    name: `Spica ${address}`,
    address,
    channels: [0, 1, 2, 3, 4],
    position: { x, y: 0, z: 0 },
    rotationRad: { x: 0, y: 0, z: 0 },
    OFLData: MOVER,
    mode: MOVER.modes[0],
    alignmentPixelSize: 0,
  });
  const a = head(0, 0);
  const b = head(5, 1);
  const truss = {
    id: 1, name: 'Truss A', members: [a, b], mappings: [],
  };
  const ids = groupsIn(layout([a, b], [truss]));
  check('the truss names the group', ids.includes('Truss A'), true);
  check(
    'and not the heads inside it',
    ids.some((id) => id.startsWith('Spica')),
    false,
  );
}

console.log('\n-- a loose split fixture still owns its own group --');
{
  const lone = {
    id: 'm9',
    name: 'Spica 9',
    address: 0,
    channels: [0, 1, 2, 3, 4],
    position: { x: 0, y: 0, z: 0 },
    rotationRad: { x: 0, y: 0, z: 0 },
    OFLData: MOVER,
    mode: MOVER.modes[0],
    alignmentPixelSize: 0,
  };
  const ids = groupsIn(layout([lone], []));
  check(
    'belonging to nothing, it is the outermost thing',
    ids.includes('Spica 9'),
    true,
  );
}

console.log('\n-- the real profile, in the shape of a real show --');
{
  // A synthetic fixture is only as good as the guess behind it. This reads
  // the profile the export actually meets -- a Spica 250M, which splits
  // because it has Pan and Tilt -- and arranges it as a real show does: two
  // structures of eight, which must not export as sixteen groups named after
  // fixtures with neither structure named anywhere.
  const file = 'public/fixtures/5star-systems/spica-250m.json';
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const mode = profile.modes.find((m) => m.name === '8bit') || profile.modes[0];
  const width = mode.channels.length;
  const spica = (n) => ({
    id: `s${n}`,
    name: `Spica 250M ${n}`,
    address: n * width,
    channels: new Array(width).fill(0),
    position: { x: n % 8, y: 0, z: n < 8 ? 0 : 2 },
    rotationRad: { x: 0, y: 0, z: 0 },
    OFLData: profile,
    mode,
    alignmentPixelSize: 0,
  });
  const heads = Array.from({ length: 16 }, (unused, n) => spica(n));
  const right = {
    id: 1, name: 'right flank', members: heads.slice(0, 8), mappings: [],
  };
  const left = {
    id: 2, name: 'left flank', members: heads.slice(8), mappings: [],
  };
  const ids = groupsIn(layout(heads, [right, left]));
  check('a Spica really does come apart', ids.length > 0, true);
  check(
    'both structures are named',
    ids.includes('right flank') && ids.includes('left flank'),
    true,
  );
  check(
    'and no head names a group of its own',
    ids.some((id) => id.startsWith('Spica')),
    false,
  );
  check('two groups, not sixteen', ids.length, 2);
}

console.log('\n-- one square per mapping keeps structures where they stand --');
{
  // Two structures of two heads, 4 m apart. A square each fits both alike;
  // one shared square keeps the gap, and a group set to another mapping still
  // gets that mapping's square.
  const near = {
    id: 1, name: 'near', members: [at(1, 0), at(4, 1)], mappings: [],
  };
  const far = {
    id: 2, name: 'far', members: [at(7, 4), at(10, 5)], mappings: [],
  };
  const wall = {
    id: 3, name: 'wall', members: [at(13, 0)], mappings: [PROJECTIONS.TOP],
  };
  const all = [...near.members, ...far.members, ...wall.members];
  const svg = (squares) => buildMadMapperLayout({
    fixtures: all,
    groups: [near, far, wall],
    projection: PROJECTIONS.FRONT,
    definitionName: () => 'beatline - Head',
    protocol: PROTOCOLS.ARTNET,
    squares,
  });
  const sizeOf = (text) => String(text).match(/width="(\d+)" height="(\d+)"/).slice(1).map(Number);
  const xsOf = (text, id) => {
    const body = String(text).match(new RegExp(`<g id="${id}">([\\s\\S]*?)</g>`))[1];
    return [...body.matchAll(/points="([-\d.]+),/g)].map((m) => Number(m[1]));
  };
  const shared = svg(SQUARES.MAPPING);
  check('two mappings, two squares in a row', sizeOf(shared), [2 * 1024 + 64, 1024]);
  const nearX = Math.max(...xsOf(shared, 'near'));
  const farX = Math.min(...xsOf(shared, 'far'));
  check('the far structure is right of the near one', farX > nearX, true);
  check('each structure keeps its group', groupsIn(shared).sort(), ['far', 'near', 'wall']);
  check('a square each is three squares in two rows', sizeOf(svg(SQUARES.GROUP)), [2 * 1024 + 64, 2 * 1024 + 64]);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
