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
  // Coalesced by three.js into a single upload before the next render, however
  // many universes arrived in between.
  texture.needsUpdate = true;
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
  attachArtNet,
  UNIVERSE_SIZE,
  USABLE_CHANNELS,
  UNIVERSE_COUNT,
};
