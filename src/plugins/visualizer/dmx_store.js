import * as THREE from 'three';
import { subscribeFrames } from '@/plugins/artnet.frames';

/**
 * @file Shared DMX data, held on the GPU.
 *
 * One texture holds every universe: 512 texels wide, one row per universe.
 * Inbound Art-Net writes a row; shaders read whichever channels they care
 * about. Nothing per-LED happens on the CPU, so cost is set by universe count
 * rather than by how many emitters are being driven.
 *
 * A fixture works out its own texel for each component, through
 * `Fixture.pixelTexels`, so how wide its pixels are and whether it keeps them
 * whole within a universe is its own business rather than this file's. The
 * 510-channel convention below serves only the fallback, for callers that
 * bring no mapping of their own.
 */

/** Channels in a DMX universe. */
const UNIVERSE_SIZE = 512;

/**
 * Channels actually used per universe.
 *
 * 510 is divisible by 3, so RGB pixels tile a universe exactly and none is ever
 * split across two.
 */
const USABLE_CHANNELS = 510;

/**
 * How many universes the texture can hold.
 *
 * A row costs 512 bytes here and the same again on the GPU, so 2048 universes
 * is a megabyte. The ceiling that would actually bite is maximum texture
 * height, typically 16384, which is about as many universes as Art-Net
 * addressing offers anyway.
 *
 * 512 was not enough, and the way it failed is the reason this is documented
 * rather than merely raised. A 256 x 256 tile driven from MadMapper arrived as
 * 777 universes; the 265 past the end were dropped, which put roughly a third
 * of the tile in the dark with nothing on screen to say why. The number here
 * has to clear the whole stream, not the fixture: a rig's last universe is set
 * by where its fixtures are patched, not by how many channels they use.
 *
 * 2048 rather than the full 16384 because the texture is re-uploaded whole on
 * any frame that changed. At 2048 that is a megabyte a frame; at 16384 it
 * would be eight, nearly all of it zeroes, for headroom no one is near. Raise
 * it when a rig needs it -- and if the upload becomes the cost, the answer is
 * to upload only the rows that moved, not to shrink this back down.
 *
 * The LED shader compiles this in as a #define and divides row indices by it,
 * so the texture and the shader are always sized from the same number.
 */
const UNIVERSE_COUNT = 2048;

/**
 * Whether a frame uploads only the universes that changed.
 *
 * Setting `needsUpdate` re-uploads the whole texture -- 512 x 2048 bytes, a
 * megabyte -- on every frame any universe moved. That costs the same whether
 * one universe arrived or four hundred, and at 60 fps it is 60 MB/s of mostly
 * zeroes pushed across Chromium's command buffer into the GPU process. The
 * useful payload is far smaller: a dodecahedron's dozen universes are 6 KB, and
 * even a 256 x 256 tile's 386 are 198 KB.
 *
 * On this path the rows that moved are tracked and handed to `flush` as one
 * sub-image upload, which makes the cost follow the rig rather than
 * `UNIVERSE_COUNT`. That is also what makes the ceiling raisable again: at
 * 16384 universes a whole-texture upload would be 8 MB a frame.
 *
 * Set to false to go back to the whole-texture upload. Nothing else changes
 * with it -- `version`, the panel refresh gate and the data itself are
 * identical either way -- so it is a straight A/B, and the only thing it can
 * decide is whether the partial path is at fault.
 *
 * @constant {Boolean}
 */
const PARTIAL_UPLOAD = true;

/** Universes already complained about, so a dropped frame is said once. */
const droppedUniverses = new Set();

const data = new Uint8Array(UNIVERSE_SIZE * UNIVERSE_COUNT);

const texture = new THREE.DataTexture(
  data,
  UNIVERSE_SIZE,
  UNIVERSE_COUNT,
  THREE.RedFormat,
  THREE.UnsignedByteType,
);
texture.minFilter = THREE.NearestFilter;
texture.magFilter = THREE.NearestFilter;
texture.needsUpdate = true;

let unsubscribe = null;

/**
 * The span of universes written since the last flush, inclusive. -1 is clean.
 *
 * One contiguous span rather than a list of runs, because a sender walks its
 * universes in order and a rig's fixtures are patched together, so the span is
 * what actually arrived, near enough. It can only over-estimate, and its worst
 * case -- one universe at each end of the texture -- is exactly the
 * whole-texture upload it replaces. There is no input on which it loses.
 */
let dirtyFirst = -1;
let dirtyLast = -1;

/**
 * Bumped by every write, and the signal LED panels refresh against.
 *
 * `texture.version` used to serve that, because setting `needsUpdate` bumps it.
 * A partial upload never touches `needsUpdate`, so the texture's own version
 * stops moving and anything gated on it would never see new DMX again. This is
 * that signal, detached from how the bytes get there.
 */
let version = 0;

/** What the last flush cost, for the perf overlay. */
const uploaded = {
  rows: 0,
  bytes: 0,
  since: 0,
  bytesPerSecond: 0,
};

/** Scratch for the flush, so a frame allocates nothing. */
const region = new THREE.Box2();
const destination = new THREE.Vector2();

/**
 * Writes one universe's worth of channels.
 *
 * @param {Number} universe 0-based universe index
 * @param {Uint8Array} frame up to 512 channel values
 */
function write(universe, frame) {
  if (universe < 0 || universe >= UNIVERSE_COUNT) {
    // Dropping it in silence is how a rig ends up half dark with nothing to
    // explain it. Said once per universe: a sender repeats itself forty times
    // a second, and the console would be useless within moments.
    if (!droppedUniverses.has(universe)) {
      droppedUniverses.add(universe);
      // eslint-disable-next-line no-console
      console.warn(`[dmx] universe ${universe} ignored: past the ${UNIVERSE_COUNT} this build holds`);
    }
    return;
  }
  data.set(frame.subarray(0, UNIVERSE_SIZE), universe * UNIVERSE_SIZE);
  version += 1;

  if (!PARTIAL_UPLOAD) {
    // Coalesced by three.js into a single upload before the next render,
    // however many universes arrived in between.
    texture.needsUpdate = true;
    return;
  }

  if (dirtyFirst < 0 || universe < dirtyFirst) dirtyFirst = universe;
  if (universe > dirtyLast) dirtyLast = universe;
}

/**
 * Pushes the dirty span to the GPU and clears it.
 *
 * @param {Object} renderer THREE.WebGLRenderer
 * @returns {Number} universes uploaded
 */
function upload(renderer) {
  const rows = dirtyLast - dirtyFirst + 1;
  // Box2 max is exclusive: three takes the height as max.y - min.y.
  region.min.set(0, dirtyFirst);
  region.max.set(UNIVERSE_SIZE, dirtyLast + 1);
  destination.set(0, dirtyFirst);
  renderer.copyTextureToTexture(texture, texture, region, destination);

  dirtyFirst = -1;
  dirtyLast = -1;
  return rows;
}

/**
 * Records what a frame's upload cost, including the frames that skip it.
 *
 * Called on every frame rather than only on the ones that upload, so an idle
 * rig reads 0 MB/s rather than holding whatever it last managed. A stale
 * number here would have hidden exactly the waste this gate was added for.
 *
 * @param {Number} rows universes uploaded this frame
 */
function meter(rows) {
  const now = performance.now();
  uploaded.rows = rows;
  uploaded.bytes += rows * UNIVERSE_SIZE;
  if (!uploaded.since) {
    uploaded.since = now;
  } else if (now - uploaded.since >= 1000) {
    uploaded.bytesPerSecond = (uploaded.bytes * 1000) / (now - uploaded.since);
    uploaded.bytes = 0;
    uploaded.since = now;
  }
}

/**
 * Uploads the universes written since the last call.
 *
 * Driven from the render loop rather than from `write`, because the copy needs
 * a renderer and Art-Net arrives nowhere near one. Cheap on a frame where
 * nothing moved: there is no span, and it returns.
 *
 * `wanted` is how the caller says whether anything reads the texture. Art-Net
 * arrives whether or not the show has a use for it, and this store has no
 * notion of a show -- it is the wire, on the GPU. An empty scene with a
 * 256 x 256 tile streaming past was uploading 7.5 MB/s to nobody. The dirty
 * span is deliberately **kept** when an upload is skipped, so a panel created
 * later gets current data on its first frame rather than waiting for each of
 * its universes to arrive again.
 *
 * `copyTextureToTexture` with this texture as both source and destination is
 * the supported route to `texSubImage2D` from three: the CPU array is the
 * source image, the GPU copy is the destination, and the unpack skip-rows it
 * sets around the call is what makes a row range mean anything. Nothing here
 * sets `needsUpdate`, which would put the whole megabyte straight back.
 *
 * @param {Object} renderer THREE.WebGLRenderer
 * @param {Boolean} [wanted] whether anything reads the texture this frame
 * @returns {Number} universes uploaded
 */
function flush(renderer, wanted = true) {
  const rows = (wanted && PARTIAL_UPLOAD && dirtyFirst >= 0 && renderer)
    ? upload(renderer)
    : 0;
  meter(rows);
  return rows;
}

/**
 * What the upload path is costing.
 *
 * @returns {Object} `{ rows, bytesPerSecond, partial }`
 */
function stats() {
  return {
    rows: uploaded.rows,
    bytesPerSecond: uploaded.bytesPerSecond,
    partial: PARTIAL_UPLOAD,
  };
}

/**
 * Routes inbound Art-Net into the texture.
 *
 * @returns {Function|null} unsubscribe handle, or null outside Electron
 */
function attachArtNet() {
  if (unsubscribe) return unsubscribe;
  unsubscribe = subscribeFrames(write);
  return unsubscribe;
}

export default {
  texture,
  write,
  flush,
  stats,
  attachArtNet,
  /** @returns {Number} bumped by every write, whatever the upload path. */
  get version() {
    return version;
  },
  UNIVERSE_SIZE,
  USABLE_CHANNELS,
  UNIVERSE_COUNT,
};
