/* eslint-disable no-console */
/**
 * The optics of a generic projector, and the channels it declares.
 *
 * Throw ratio is the one number every projector spec sheet prints, and the
 * whole frustum follows from it. Getting the conversion wrong gives a projector
 * that looks plausible and covers the wrong wall -- an error nobody can see by
 * eye, because there is nothing to compare it against until the image lands on
 * geometry.
 *
 * The defining identity, checked several ways below:
 *
 *     TR = throw distance / image width
 *
 * so the picture's width is D/TR at any distance, and the angle that implies is
 * independent of D. That independence is what makes throw ratio the number
 * worth storing rather than any particular picture.
 *
 * Usage:
 *   npm test
 */
import {
  DEFAULT_PROJECTOR_PARAMS,
  PROJECTOR_CHANNELS,
  buildProjectorProfile,
  projectorChannels,
  isProjectorProfile,
  imageAspect,
  imageSizeAt,
  lensOrigin,
  throwAngles,
  throwFrustum,
  illuminanceAt,
  throwRange,
  clampThrow,
} from '@/models/DMX/generic/projector';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Angles are irrational; compare them to a tenth of a degree. */
function near(label, got, want, tolerance = 0.05) {
  const ok = Math.abs(got - want) <= tolerance;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${Number(got).toFixed(4)}  want ${Number(want).toFixed(4)}`,
  );
}

/** WUXGA, so the image is 16:10 and the vertical is not the horizontal. */
const params = { ...DEFAULT_PROJECTOR_PARAMS };

console.log('\n-- the image is shaped by the imager --');
{
  check('16:10 native gives 0.625', imageAspect(params), 0.625);
  check('a square imager gives 1', imageAspect({ pixelsWide: 1024, pixelsHigh: 1024 }), 1);
  check('16:9 native', imageAspect({ pixelsWide: 3840, pixelsHigh: 2160 }), 0.5625);
}

console.log('\n-- throw ratio to frustum --');
{
  // tan(h/2) = 1/(2*TR).  At TR = 0.5 the half-angle is atan(1) = 45 degrees,
  // which is the one case worth being able to check in your head.
  near('TR 0.5 is a 90 degree lens', throwAngles(0.5, params).horizontal, 90);
  near('TR 1.0', throwAngles(1, params).horizontal, 2 * Math.atan(0.5) * (180 / Math.PI));
  near('TR 1.0 is 53.1 degrees', throwAngles(1, params).horizontal, 53.1301);
  near('TR 2.0 is 28.1 degrees', throwAngles(2, params).horizontal, 28.0725);
  near('a longer lens is a narrower one',
    throwAngles(2.32, params).horizontal < throwAngles(1.44, params).horizontal ? 1 : 0, 1);

  // The vertical is the same lens seen through the image's own shape.
  near('vertical at TR 1.0 on 16:10',
    throwAngles(1, params).vertical, 2 * Math.atan(0.625 / 2) * (180 / Math.PI));
  near('a square imager throws a square frustum',
    throwAngles(1.5, { pixelsWide: 1024, pixelsHigh: 1024 }).vertical,
    throwAngles(1.5, { pixelsWide: 1024, pixelsHigh: 1024 }).horizontal);
}

console.log('\n-- the picture on the wall --');
{
  const at6 = imageSizeAt(6, 1.5, params);
  near('6 m at TR 1.5 is 4 m wide', at6.width, 4);
  near('and 2.5 m high at 16:10', at6.height, 2.5);

  // The identity itself: width over distance is 1/TR, whatever the distance.
  // This is what makes the angle independent of D, and the reason a spec sheet
  // can quote one number instead of a table.
  const ratios = [1, 4, 12.5, 40].map((d) => imageSizeAt(d, 1.6, params).width / d);
  near('width/distance is 1/TR at 1 m', ratios[0], 1 / 1.6);
  near('and unchanged at 40 m', ratios[3], 1 / 1.6);
  check('every distance agrees', new Set(ratios.map((r) => r.toFixed(9))).size, 1);

  // And the round trip: the angle and the size have to describe one lens.
  const tr = 1.8;
  const halfWidth = imageSizeAt(10, tr, params).width / 2;
  near('the angle matches the picture it makes',
    2 * Math.atan(halfWidth / 10) * (180 / Math.PI), throwAngles(tr, params).horizontal);
}

console.log('\n-- the zoom range --');
{
  check('sorted as given', JSON.stringify(throwRange({ throwMin: 1.2, throwMax: 1.8 })), '{"min":1.2,"max":1.8}');
  // A spec sheet quotes them either way round, and both fields are typed by
  // hand, so the wrong order must not invert the lens.
  check('sorted when reversed', JSON.stringify(throwRange({ throwMin: 1.8, throwMax: 1.2 })), '{"min":1.2,"max":1.8}');
  check('a prime lens is a range of one', JSON.stringify(throwRange({ throwMin: 1.5 })), '{"min":1.5,"max":1.5}');

  check('clamped up to the wide end', clampThrow(params, 0.1), params.throwMin);
  check('clamped down to the long end', clampThrow(params, 99), params.throwMax);
  check('left alone in range', clampThrow(params, 1.8), 1.8);
  check('nonsense falls to the wide end', clampThrow(params, NaN), params.throwMin);
}

console.log('\n-- the channels a model declares --');
{
  const none = projectorChannels({ ...params, channels: [] });
  check('a projector may have no DMX at all', none.modes[0].channels.length, 0);
  check('and still declares a mode', none.modes.length, 1);

  const all = projectorChannels({ ...params, channels: Object.values(PROJECTOR_CHANNELS) });
  check('six channels when all are ticked', all.modes[0].channels.length, 6);
  check('dimmer leads', all.modes[0].channels[0], 'Dimmer');
  check('source select is last', all.modes[0].channels[5], 'Source Select');

  // The order is the file's, not the order they were ticked -- two projectors
  // with the same channels have to address alike or a patch sheet is a lottery.
  const ticked = projectorChannels({
    ...params,
    channels: [PROJECTOR_CHANNELS.SOURCE, PROJECTOR_CHANNELS.DIMMER],
  });
  check('ticking order does not set address order',
    JSON.stringify(ticked.modes[0].channels), '["Dimmer","Source Select"]');

  check('a dimmer is an intensity',
    all.availableChannels.Dimmer.capability.type, 'Intensity');
  check('a shutter is a shutter',
    all.availableChannels.Shutter.capability.type, 'ShutterStrobe');
  check('zoom carries the angles it spans',
    all.availableChannels.Zoom.capability.angleEnd,
    `${throwAngles(params.throwMin, params).horizontal.toFixed(1)}deg`);
}

console.log('\n-- where the lens sits on the body --');
{
  // +Z is up and the throw runs along -Y, so an unrotated projector stands on
  // its feet and faces the scene's Front. Pinned because reading the bar's +Z
  // as "wherever the light goes" once aimed every projector at the ceiling.
  const centred = lensOrigin(params);
  check('a centred lens is on the axis', `${centred.x},${centred.z}`, '0,0');
  check('and stands off the front face', centred.y,
    -(params.depth / 2 + params.lensProtrusion));
  check('the front face is forward, not up', centred.y < 0, true);

  const offset = lensOrigin({ ...params, lensX: 0.12, lensY: -0.04 });
  check('across the panel is local x', offset.x, 0.12);
  check('up the panel is local z, signed', offset.z, -0.04);
  check('neither moves the lens forward', offset.y, centred.y);

  // A flush lens still leaves the panel, not the middle of the box: a frustum
  // starting at the fixture's position would begin inside its own housing.
  check('a flush lens sits on the panel',
    lensOrigin({ ...params, lensProtrusion: 0 }).y, -params.depth / 2);
  check('a missing body falls back rather than to zero',
    lensOrigin({ lensProtrusion: 0 }).y, -DEFAULT_PROJECTOR_PARAMS.depth / 2);
}

console.log('\n-- the profile as a whole --');
{
  const profile = buildProjectorProfile();
  check('is recognisable as one of ours', isProjectorProfile(profile), true);
  check('an LED bar is not', isProjectorProfile({ asls: { bar: {} } }), false);
  check('nor is nothing', isProjectorProfile(null), false);
  check('carries its parameters', profile.asls.projector.pixelsWide, 1920);
  // OFL's order is width, height, depth -- which is not the renderer's axis
  // order (x across, y forward, z up). Two different questions, both right.
  check('dimensions in millimetres', JSON.stringify(profile.physical.dimensions), '[490,200,550]');
  check('the lens travels with the profile', profile.asls.projector.lensDiameter, 0.12);

  // `physical.lens.degreesMinMax` is read narrowest-first by the fixture model,
  // and a *larger* throw ratio is the narrower lens -- so the two ends swap on
  // the way in. Getting this backwards would give every projector its zoom
  // inverted.
  const lens = profile.physical.lens.degreesMinMax;
  near('narrowest angle first', lens[0], throwAngles(params.throwMax, params).horizontal);
  near('widest angle second', lens[1], throwAngles(params.throwMin, params).horizontal);
  check('and they are in ascending order', lens[0] < lens[1], true);

  const bare = buildProjectorProfile({ channels: [] });
  check('a projector with no DMX still builds', bare.modes[0].channels.length, 0);
  check('and still has its optics', bare.asls.projector.throwMin, params.throwMin);
}

console.log('\n-- the frustum a coverage preview is drawn from --');
{
  const p = { ...DEFAULT_PROJECTOR_PARAMS, pixelsWide: 1920, pixelsHigh: 1080 };
  const on = throwFrustum(p, 1.5);
  // TR = distance / image width, so at one metre the picture is 1/1.5 wide.
  check('width at one metre is 1/TR', (on.right - on.left).toFixed(6), (1 / 1.5).toFixed(6));
  check('and the height follows the imager', ((on.top - on.bottom) / (on.right - on.left)).toFixed(6),
    (1080 / 1920).toFixed(6));
  check('unshifted, the axis is the centre', (on.left + on.right).toFixed(9), '0.000000000');

  // Shift moves the picture without changing its size: that is the whole
  // point of it, and the reason aiming the projector up instead is wrong.
  const up = throwFrustum(p, 1.5, 0, 0.5);
  check('shifting does not resize', (up.right - up.left).toFixed(6), (on.right - on.left).toFixed(6));
  check('nor change the height', (up.top - up.bottom).toFixed(6), (on.top - on.bottom).toFixed(6));
  // 50% of the full height puts the lens axis exactly on the bottom edge.
  check('50% vertical puts the axis on the edge', up.bottom.toFixed(9), '0.000000000');

  const down = throwFrustum(p, 1.5, 0, -0.5);
  check('and it is symmetric the other way', down.top.toFixed(9), '0.000000000');

  // A machine cannot shift further than its optics allow.
  const limited = throwFrustum({ ...p, shiftLimitV: 20 }, 1.5, 0, 1);
  const expected = throwFrustum({ ...p, shiftLimitV: 20 }, 1.5, 0, 0.2);
  check('shift is clamped to the machine', limited.top.toFixed(9), expected.top.toFixed(9));

  // The identity the whole model rests on, at a second distance.
  const wide = throwFrustum(p, 0.8);
  check('a shorter throw makes a wider picture', (wide.right - wide.left) > (on.right - on.left), true);
  check('by exactly the ratio', ((wide.right - wide.left) / (on.right - on.left)).toFixed(6),
    (1.5 / 0.8).toFixed(6));
}

console.log('\n-- what the lumen rating actually buys --');
{
  const p = { ...DEFAULT_PROJECTOR_PARAMS, lumens: 10000, pixelsWide: 1920, pixelsHigh: 1200 };
  // Paul's own rig, and the anchor the renderer is calibrated against.
  const at27 = illuminanceAt(27, 1.5, p);
  check('a 10k machine 27 m off a facade', Math.round(at27), 49);

  // Inverse square, because the picture grows with distance in both axes.
  const at54 = illuminanceAt(54, 1.5, p);
  check('twice the distance is a quarter the light', (at27 / at54).toFixed(3), '4.000');

  // The part that was missing before: the lens decides the area, so zoom is
  // brightness. A longer throw ratio is a narrower lens.
  const narrow = illuminanceAt(27, 3.0, p);
  check('doubling the throw ratio quadruples the light', (narrow / at27).toFixed(3), '4.000');

  check('twice the lumens is twice the light',
    (illuminanceAt(27, 1.5, { ...p, lumens: 20000 }) / at27).toFixed(3), '2.000');
  check('no lumens is no light', illuminanceAt(27, 1.5, { ...p, lumens: 0 }), 0);
}

console.log('\n-- shift points the way the fixture does --');
{
  const p = { ...DEFAULT_PROJECTOR_PARAMS, pixelsWide: 1920, pixelsHigh: 1080 };
  // Shift is quoted the way projectors quote it: from behind the machine,
  // looking the way it throws. These extents are in the lens camera's frame,
  // where that observer's right is +X -- so a positive shift is a positive
  // centre here. The fixture's own frame runs the other way, and reasoning
  // from `lensX` to this is what briefly inverted it.
  const right = throwFrustum(p, 1.5, 0.25, 0);
  check('a positive shift moves the picture to the lens frame +X',
    ((right.left + right.right) / 2) > 0, true);
  const left = throwFrustum(p, 1.5, -0.25, 0);
  check('and the other way round', ((left.left + left.right) / 2) < 0, true);
  check('equal and opposite', ((right.left + right.right) / 2).toFixed(6),
    (-(left.left + left.right) / 2).toFixed(6));

  // Vertical is not crossed over: the camera's up is the fixture's +Z.
  const up = throwFrustum(p, 1.5, 0, 0.25);
  check('a shift up is up in both frames', ((up.top + up.bottom) / 2) > 0, true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
