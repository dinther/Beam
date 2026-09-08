/* eslint-disable no-console */
/* eslint-disable no-bitwise */
/**
 * The Ponk receiver and the dwell model that stands in for the rasteriser.
 *
 * MadMapper publishes each laser output as its own Ponk stream: a named,
 * chunked UDP frame of paths. The decoder is checked against packets built by
 * the encoder that lives beside it, so the layout one reads is the layout the
 * other writes; then against the things a network does -- chunks out of order,
 * a corrupted frame, a sender talking over another.
 *
 * The dwell model is checked as arithmetic: a point budget spent over paths by
 * length, dots off the top, a line across the field weighing exactly one.
 *
 * Usage:
 *   npm test
 */
import {
  PonkAssembler, decodeFrame, encodeFrame, readHeader, frameCrc,
  FORMAT_XYRGB_U16, FORMAT_XY_F32_RGB_U8, HEADER_BYTES,
} from '@/electron/ponk';
import {
  flattenPaths, dwellWeights, pathLength, DWELL_DEFAULTS, POINT_STRIDE,
} from '@/plugins/visualizer/laser_dwell';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

function near(label, got, want, tol = 1e-4) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got ${got}  want ~${want}`);
}

/** A line of `n` points from (x0,y0) to (x1,y1) in one colour. */
function line(n, x0, y0, x1, y1, rgb = [255, 0, 0], meta = {}) {
  const xy = []; const col = [];
  for (let i = 0; i < n; i += 1) {
    const t = n > 1 ? i / (n - 1) : 0;
    xy.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    col.push(...rgb);
  }
  return { xy, rgb: col, meta };
}

console.log('\n-- a frame survives the round trip --');

{
  const frame = {
    sender: 0x300c,
    name: 'MadMapper-Left',
    frame: 7,
    paths: [
      line(5, -0.5, 0, 0.5, 0, [255, 0, 0], { MAXSPEED: 1, MINIPNTS: 12 }),
      line(3, 0, -0.2, 0, 0.2, [0, 255, 0]),
    ],
  };
  const packets = encodeFrame(frame, 60); // tiny chunks, so there are several
  check('chunked into more than one packet', packets.length > 1, true);
  const h = readHeader(packets[0]);
  check('header reads the sender id', h.sender, 0x300c);
  check('and the name', h.name, 'MadMapper-Left');
  check('and the frame number', h.frame, 7);
  check('chunk count matches', h.chunkCount, packets.length);
  check('not a Ponk packet: null', readHeader(Buffer.from('hello world, not ponk at all', 'ascii')), null);
  check('too short: null', readHeader(Buffer.alloc(HEADER_BYTES - 1)), null);

  const got = [];
  const asm = new PonkAssembler((f) => got.push(f));
  // Delivered backwards, as multicast is allowed to.
  [...packets].reverse().forEach((p) => asm.push(p));
  check('one frame out', got.length, 1);
  check('two paths', got[0].paths.length, 2);
  check('first path count', got[0].paths[0].count, 5);
  check('point x survives as float', got[0].paths[0].xy[0], -0.5);
  check('point colour survives', got[0].paths[0].rgb[0], 255);
  check('meta MINIPNTS survives', got[0].paths[0].meta.MINIPNTS, 12);
  check('meta MAXSPEED survives', got[0].paths[0].meta.MAXSPEED, 1);
  check('second path colour', got[0].paths[1].rgb[1], 255);
  check('format reported', got[0].format, FORMAT_XY_F32_RGB_U8);
}

console.log('\n-- what a network does --');

{
  const packets = encodeFrame({
    sender: 1, name: 'a', frame: 1, paths: [line(4, 0, 0, 1, 1)],
  }, 30);
  const got = [];
  const asm = new PonkAssembler((f) => got.push(f));
  // Flip one data octet: the sum no longer agrees and the frame is dropped.
  const bad = Buffer.from(packets[1]);
  bad[HEADER_BYTES + 2] ^= 0x40;
  asm.push(packets[0]);
  asm.push(bad);
  packets.slice(2).forEach((p) => asm.push(p));
  check('corrupted frame dropped', got.length, 0);
  check('and counted', asm.badCrc, 1);

  // A newer frame abandons an incomplete older one rather than mixing them.
  const f1 = encodeFrame({
    sender: 2, name: 'b', frame: 1, paths: [line(4, 0, 0, 1, 1)],
  }, 30);
  const f2 = encodeFrame({
    sender: 2, name: 'b', frame: 2, paths: [line(2, 0, 0, 1, 1)],
  }, 30);
  const got2 = [];
  const asm2 = new PonkAssembler((f) => got2.push(f));
  asm2.push(f1[0]);
  f2.forEach((p) => asm2.push(p));
  check('newer frame delivered', got2.length, 1);
  check('it is frame 2', got2[0].frame, 2);
  check('the stale chunk is forgotten', asm2.pending.size, 0);

  // Two senders interleaved stay apart.
  const l = encodeFrame({
    sender: 0x300c, name: 'Left', frame: 9, paths: [line(3, 0, 0, 1, 0)],
  }, 30);
  const r = encodeFrame({
    sender: 0x300d, name: 'Right', frame: 9, paths: [line(2, 0, 0, 0, 1)],
  }, 30);
  const got3 = [];
  const asm3 = new PonkAssembler((f) => got3.push(f));
  l.forEach((p, i) => { asm3.push(p); if (r[i]) asm3.push(r[i]); });
  r.slice(l.length).forEach((p) => asm3.push(p));
  check('both senders delivered', got3.map((f) => f.name).sort().join(), 'Left,Right');
  check('with their own point counts', got3.map((f) => f.paths[0].count).sort().join(), '2,3');

  // Format 0 decodes to the same floats.
  const u16 = encodeFrame({
    sender: 3, name: 'c', frame: 1, format: FORMAT_XYRGB_U16, paths: [line(2, -1, 0.5, 1, -0.5, [128, 64, 0])],
  });
  const d = decodeFrame(u16[0].subarray(HEADER_BYTES));
  check('format 0 read', d.format, FORMAT_XYRGB_U16);
  near('format 0 x at -1', d.paths[0].xy[0], -1, 1e-3);
  near('format 0 y at 0.5', d.paths[0].xy[1], 0.5, 1e-3);
  check('format 0 colour to 8 bits', d.paths[0].rgb[0], 128);
  check('unknown format: null', decodeFrame(Buffer.from([9, 0, 0, 0])), null);
  check('truncated frame: null', decodeFrame(Buffer.from([1, 0, 5, 0, 1, 2])), null);
  // The format byte leads every path, as the stream has it -- a frame laid out
  // with it once at the front is exactly what rejected every multi-path frame.
  const twoPaths = Buffer.concat([
    Buffer.from([1, 0, 1, 0]), Buffer.alloc(11), // format, no meta, 1 point
    Buffer.from([1, 0, 1, 0]), Buffer.alloc(11),
  ]);
  check('per-path format bytes parse', decodeFrame(twoPaths).paths.length, 2);
  check('and each path knows its format', decodeFrame(twoPaths).paths[1].format, 1);
  const onceOnly = Buffer.concat([
    Buffer.from([1]),
    Buffer.from([0, 1, 0]), Buffer.alloc(11),
    Buffer.from([0, 1, 0]), Buffer.alloc(11),
  ]);
  check('the header-file layout is rejected', decodeFrame(onceOnly), null);

  // The checksum rule, as pinned against MadMapper: a byte sum.
  check('crc is the byte sum', frameCrc(Buffer.from([1, 2, 250, 255])), 508);
}

console.log('\n-- flattening: a DAC-shaped run with blanks between paths --');

{
  const path = (xy, rgb) => ({
    count: 2, xy: new Float32Array(xy), rgb: new Uint8Array(rgb), meta: {},
  });
  const paths = [
    path([-1, 0, 1, 0], [255, 0, 0, 255, 0, 0]),
    path([0, -1, 0, 1], [0, 0, 255, 0, 0, 255]),
  ];
  const flat = flattenPaths(paths, { pointRate: 30000, dwell: false });
  check('2 + blank + 2 points', flat.count, 5);
  check('x of -1 as signed bit pattern', (flat.points[0] << 16) >> 16, -32767);
  check('x of +1', (flat.points[POINT_STRIDE] << 16) >> 16, 32767);
  check('red widened to 16 bits', flat.points[2], 65535);
  check('intensity full', flat.points[5], 65535);
  const blank = 2 * POINT_STRIDE;
  check('blank sits at the next path start x', (flat.points[blank] << 16) >> 16, 0);
  check('blank is dark', flat.points[blank + 2] + flat.points[blank + 3] + flat.points[blank + 4], 0);
  check('blank weighs nothing', flat.weights[2], 0);
  check('model off: weight 1', flat.weights[0], 1);
  const cut = flattenPaths(paths, { pointRate: 30000, dwell: false, maxPoints: 3 });
  check('capacity cuts the run', cut.count, 3);
  check('empty frame', flattenPaths([], { pointRate: 30000 }).count, 0);

  // A circle sampled far denser than a pixel is thinned to one, whole. The
  // real case: 8,146 points for one ring against a 4,096 cap drew half of it.
  const n = 8000;
  const ring = {
    count: n, xy: new Float32Array(n * 2), rgb: new Uint8Array(n * 3), meta: {},
  };
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    ring.xy[i * 2] = 0.6 * Math.cos(a);
    ring.xy[i * 2 + 1] = 0.6 * Math.sin(a);
    ring.rgb[i * 3] = 255;
  }
  const thin = flattenPaths([ring], { pointRate: 30000, maxPoints: 16384 });
  // Greedy: a point is kept once it is at least `minStep` from the last one
  // kept, so the real spacing overshoots to the next source point. These sit
  // 0.00047 apart, so every fifth is kept and 8,000 becomes 1,600 -- not the
  // 1,885 an exact 0.002 step would give.
  check('thinned to about a point per pixel', thin.count, 1601);
  const at = (i, k) => ((thin.points[i * POINT_STRIDE + k] << 16) >> 16) / 32767;
  let minKept = Infinity;
  for (let i = 2; i < thin.count - 1; i += 1) {
    minKept = Math.min(minKept, Math.hypot(at(i, 0) - at(i - 1, 0), at(i, 1) - at(i - 1, 1)));
  }
  check('no two kept points closer than the step', minKept >= 0.002, true);
  // The end of a stroke is never thinned away: a ring has to close.
  check('the last point is kept', Math.abs(at(thin.count - 1, 0) - 0.6) < 1e-3, true);
  check('and it closes the ring', Math.abs(at(thin.count - 1, 1)) < 1e-2, true);
  const coarse = flattenPaths([ring], { pointRate: 30000, minStep: 0 });
  check('no thinning when asked', coarse.count, 4096);
  check('and the thinned points carry a weight', thin.weights[0] > 0, true);
}

console.log('\n-- the dwell model --');

{
  const red = (n) => new Uint8Array(Array.from({ length: n * 3 }, (_, i) => (i % 3 ? 0 : 255)));
  const across = {
    count: 2, xy: new Float32Array([-1, 0, 1, 0]), rgb: red(2), meta: {},
  };
  const short = {
    count: 2, xy: new Float32Array([0, 0, 0.1, 0]), rgb: red(2), meta: {},
  };
  const dot = {
    count: 1, xy: new Float32Array([0.3, 0.3]), rgb: red(1), meta: {},
  };
  near('length of a line across the field', pathLength(across.xy, 2), 2);
  check('one line across the field weighs 1', dwellWeights([across], 30000)[0], 1);
  check('no rate: weight 1', dwellWeights([across], 0)[0], 1);

  // Two lines across: the budget is split, each is half as bright.
  const two = dwellWeights([across, across], 30000);
  near('two lines share the budget', two[0], 0.5);

  // Points are spread by length, so a short line beside a long one is no
  // hotter by itself -- the same density everywhere, both a little under 1
  // because the frame holds 2.1 units of line for a budget that makes 2 read
  // as 1. What lifts a short path is the rasteriser's floor, next.
  const w = dwellWeights([across, short], 30000);
  near('the same density on both', w[1], w[0], 1e-3);
  // 30000/60 = 500 budget over 2.1 units = 238/unit against a reference 250.
  near('a little under one', w[0], (500 / 2.1) / 250, 1e-3);
  const withFloor = dwellWeights([across, { ...short, meta: { MINIPNTS: 60 } }], 30000);
  near('MINIPNTS lifts it', withFloor[1], 60 / 0.1 / 250, 1e-3);
  check('never past the cap', dwellWeights([{ ...short, xy: new Float32Array([0, 0, 0.001, 0]) }], 30000)[0], DWELL_DEFAULTS.maxWeight);

  // A dot: its points against the reference dot.
  near('a dot at the default count', dwellWeights([dot], 30000)[0], DWELL_DEFAULTS.dotPoints / DWELL_DEFAULTS.dotRefPoints);
  near('SNGLPTIN sets a dot', dwellWeights([{ ...dot, meta: { SNGLPTIN: 30 } }], 30000)[0], 3);
  // Dots come off the top; the line keeps at least its floor share.
  const many = dwellWeights([across, ...Array.from({ length: 30 }, () => dot)], 30000);
  near('thirty dots leave the line its floor', many[0], (500 * DWELL_DEFAULTS.lineFloor) / 2 / 250);
  // Through flatten, the weight lands on every point of the path.
  const flat = flattenPaths([across, across], { pointRate: 30000 });
  near('weights on the points', flat.weights[0], 0.5);
  near('and on the second path', flat.weights[flat.count - 1], 0.5);
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
if (failures) process.exit(1);
