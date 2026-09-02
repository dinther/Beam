/* eslint-disable no-console */
/**
 * What a video connector's rotation and flip actually mean.
 *
 * `sampleAt` is the one place that says how a quarter turn and a mirror are
 * applied, and it has two callers coming: the slicing preview draws with it
 * today and a patched device will sample with it later. A quarter turn is the
 * classic thing that looks plausible and is mirrored, and a picture cannot be
 * unit tested -- so the corners are pinned here instead.
 *
 * The convention under test, which is a decision rather than a discovery:
 * output space has its origin at the top-left of what the device receives, the
 * region is turned **clockwise**, and the mirrors are applied afterwards in
 * the output's own axes.
 *
 * Usage:
 *   npm test
 */
import VideoConnector from '@/models/DMX/video_connector';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Corners are exact in this maths, so an epsilon would hide a real error. */
function corner(connector, u, v) {
  const at = connector.sampleAt(u, v);
  return `${Math.round(at.x * 1000) / 1000},${Math.round(at.y * 1000) / 1000}`;
}

/**
 * The left half of the frame, so a mirror cannot be mistaken for the identity
 * -- a region centred on the frame maps onto itself under some of these.
 */
function half(data = {}) {
  return new VideoConnector({
    rect: {
      x: 0, y: 0, width: 0.5, height: 1,
    },
    ...data,
  });
}

console.log('\n-- no transform --');
{
  const plain = half();
  check('output top-left is the region top-left', corner(plain, 0, 0), '0,0');
  check('output top-right is the region top-right', corner(plain, 1, 0), '0.5,0');
  check('output bottom-left is the region bottom-left', corner(plain, 0, 1), '0,1');
  check('a region is not the whole frame', corner(plain, 1, 1), '0.5,1');
}

console.log('\n-- an offset region --');
{
  const offset = new VideoConnector({
    rect: {
      x: 0.25, y: 0.5, width: 0.25, height: 0.5,
    },
  });
  check('the crop offsets the origin', corner(offset, 0, 0), '0.25,0.5');
  check('and scales the far corner', corner(offset, 1, 1), '0.5,1');
}

console.log('\n-- quarter turns, clockwise --');
{
  // Turning a picture clockwise carries its bottom-left corner to the top-left
  // of what you then look at. Every line below is that one sentence, checked
  // from a different corner.
  const cw = half({ rotation: 90 });
  check('90: output top-left is the region bottom-left', corner(cw, 0, 0), '0,1');
  check('90: output top-right is the region top-left', corner(cw, 1, 0), '0,0');
  check('90: output bottom-right is the region top-right', corner(cw, 1, 1), '0.5,0');
  check('90: output bottom-left is the region bottom-right', corner(cw, 0, 1), '0.5,1');

  const half_turn = half({ rotation: 180 });
  check('180: output top-left is the region bottom-right', corner(half_turn, 0, 0), '0.5,1');
  check('180: output bottom-right is the region top-left', corner(half_turn, 1, 1), '0,0');

  const ccw = half({ rotation: 270 });
  check('270: output top-left is the region top-right', corner(ccw, 0, 0), '0.5,0');
  check('270: output bottom-right is the region bottom-left', corner(ccw, 1, 1), '0,1');
}

console.log('\n-- mirrors, in the output\'s own axes --');
{
  const flipped = half({ flipH: true });
  check('flip H swaps left for right', corner(flipped, 0, 0), '0.5,0');
  check('flip H leaves the vertical alone', corner(flipped, 0, 1), '0.5,1');

  const overturned = half({ flipV: true });
  check('flip V swaps top for bottom', corner(overturned, 0, 0), '0,1');

  const both = half({ flipH: true, flipV: true });
  check('both mirrors is a half turn', corner(both, 0, 0), '0.5,1');
  check('and 180 agrees with it', corner(half({ rotation: 180 }), 0, 0), '0.5,1');
}

console.log('\n-- rotate then flip, not the other way round --');
{
  // The distinguishing case: with the turn applied first, Flip H mirrors what
  // the viewer sees left-to-right. Applied the other way round the same tick
  // would mirror it top-to-bottom, which is what makes the order worth pinning
  // rather than leaving to whichever line happened to come first.
  const turnedAndMirrored = half({ rotation: 90, flipH: true });
  check('90 + flip H: top-left is the region top-left', corner(turnedAndMirrored, 0, 0), '0,0');
  check('90 + flip H: top-right is the region bottom-left', corner(turnedAndMirrored, 1, 0), '0,1');
  check('and it is NOT 90 + flip V', corner(half({ rotation: 90, flipV: true }), 0, 0), '0.5,1');
}

console.log('\n-- the shape the device is handed --');
{
  // A 4K frame carved into a tall sliver: an eighth of the width, half the
  // height, so 480 x 1080 pixels of a 3840 x 2160 source.
  const sliver = new VideoConnector({
    rect: {
      x: 0, y: 0, width: 0.125, height: 0.5,
    },
  });
  check('a region is measured in the frame\'s pixels', sliver.outputAspect(16 / 9), (0.125 * (16 / 9)) / 0.5);
  check('and comes out portrait', sliver.outputAspect(16 / 9) < 1, true);
  check('unturned, the size is the region', JSON.stringify(sliver.outputSize(3840, 2160)), '{"width":480,"height":1080}');

  sliver.rotation = 90;
  check('a quarter turn transposes the size', JSON.stringify(sliver.outputSize(3840, 2160)), '{"width":1080,"height":480}');
  check('and inverts the shape', Math.round(sliver.outputAspect(16 / 9) * 1e6), Math.round((1 / ((0.125 * (16 / 9)) / 0.5)) * 1e6));
  check('a half turn does not', (() => { sliver.rotation = 180; return JSON.stringify(sliver.outputSize(3840, 2160)); })(), '{"width":480,"height":1080}');
  check('an unknown frame shape gives no aspect', sliver.outputAspect(0), 0);
}

console.log('\n-- every point stays inside the region --');
{
  // The property that matters to a sampler: whatever the transform, nothing
  // reads outside the rectangle the user drew. A connector that sampled its
  // neighbour would show up as content bleeding between two devices.
  const region = new VideoConnector({
    rect: {
      x: 0.3, y: 0.1, width: 0.4, height: 0.25,
    },
  });
  let outside = 0;
  [0, 90, 180, 270].forEach((rotation) => {
    [false, true].forEach((flipH) => {
      [false, true].forEach((flipV) => {
        Object.assign(region, { rotation, flipH, flipV });
        for (let i = 0; i <= 10; i += 1) {
          for (let j = 0; j <= 10; j += 1) {
            const at = region.sampleAt(i / 10, j / 10);
            if (at.x < 0.3 - 1e-9 || at.x > 0.7 + 1e-9
              || at.y < 0.1 - 1e-9 || at.y > 0.35 + 1e-9) outside += 1;
          }
        }
      });
    });
  });
  check('1936 samples over 16 transforms, none outside', outside, 0);
}

console.log('\n-- written down in pixels, read back exactly --');
{
  // The case percentages could not express: a tenth of a percent of a 4K frame
  // is 3.84 pixels, so a whole number in that space never lands on an edge.
  const slice = new VideoConnector({ rect: { x: 0, y: 0, width: 0.5, height: 1 } });
  slice.setPixelRect({ x: 1650, width: 540 }, 3840, 2160);
  const px = slice.pixelRect();
  check('x survives the round trip', px.x, 1650);
  check('and so does the width', px.width, 540);
  check('the authoring frame is kept', slice.frame.width + 'x' + slice.frame.height, '3840x2160');

  const written = slice.showData;
  check('show data carries pixels, not fractions', written.rect.x, 1650);
  check('and the frame beside them', written.frame.width, 3840);

  const reloaded = new VideoConnector(written);
  check('a reloaded slice is the same pixels', reloaded.pixelRect().x, 1650);
  check('and samples the same place', reloaded.rect.x, 1650 / 3840);
  // Why it is still held as a fraction underneath.
  check('a smaller sender scales it', JSON.stringify(reloaded.pixelRect(1920, 1080)),
    JSON.stringify({ x: 825, y: 0, width: 270, height: 1080 }));
}

console.log('\n-- a show written before any of this still loads --');
{
  const legacy = new VideoConnector({ rect: { x: 0.25, y: 0, width: 0.5, height: 1 } });
  check('no frame means the numbers are fractions', legacy.rect.x, 0.25);
  check('and there are no pixels to give', legacy.pixelRect(), null);
  check('until a frame is named', legacy.pixelRect(3840, 2160).x, 960);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
