/* eslint-disable no-console */
/**
 * @file The laser inputs the show asks for, made real.
 *
 * Every laser fixture says how it wants to be fed -- a protocol, and for the
 * DAC protocols an address -- and this turns that list into running devices.
 * The show is the source of truth; this reconciles the machine to it.
 *
 * **Why the address is a per-laser setting.** A real laser has a DAC in it, so
 * "this one is a LaserCube at 192.168.1.2" is a property of the fixture, not
 * of the application. It is also the only honest way to say how many lasers a
 * protocol can carry: Ether Dream and LaserCube identify a device *by its
 * address* and carry no name, so one laser may hold one address, and a second
 * needs a second address. Paul: *"LaserCube and Etherdream only exclusive if
 * they must share the same IP address... the user can if savvy add additional
 * IP to the network setup."* So Beam asks nothing of anyone's network -- the
 * default is one device on the primary address -- and does not pretend the
 * ceiling is not there.
 *
 * IDN is the exception and the reason it is worth preferring: one unit at one
 * address offers a **named service per laser**, so a whole rig fits on one
 * address. Beam has implemented that since the start; MadMapper is the one that
 * does not send a service ID (see `docs/madmapper-idn-service-map.md`), which
 * is why `serviceZero` is reported -- a producer that names nothing is a fact
 * the user should be told, not a silent mis-route.
 *
 * Ponk has no address here at all: it is a multicast receive, one socket for
 * the machine, and a laser picks its stream by the sender identifier that
 * MadMapper keeps stable across project reloads.
 */
import os from 'os';
import EtherDreamDac from './etherdream';
import LaserCubeDac from './lasercube';
import IdnDac from './idn';
import PonkReceiver from './ponk';

/** How a laser may be fed. */
export const PROTOCOLS = ['ponk', 'idn', 'etherdream', 'lasercube'];

/**
 * Protocols that identify a device only by its address, so one laser each.
 *
 * IDN is absent because its services name the lasers behind one address; Ponk
 * is absent because it is received rather than advertised.
 */
export const EXCLUSIVE = ['etherdream', 'lasercube'];

/** Builds the DAC for a protocol, bound to one address. */
const BUILDERS = {
  etherdream: () => new EtherDreamDac(),
  lasercube: () => new LaserCubeDac(),
  idn: () => new IdnDac(),
};

/**
 * The addresses a device may be bound to, best first.
 *
 * Real IPv4 interface addresses only. A user who adds one in Windows sees it
 * here next time, which is the whole of the "savvy user" path -- no typing, and
 * nothing that cannot be bound.
 *
 * **An address in this list is not a promise that a producer will find it.**
 * MadMapper's discovery reached this machine's Ethernet address and loopback
 * but not its Wi-Fi address, and reached no `127.0.0.x` alias at all. That is
 * the producer's business, not ours; the status a device reports is what tells
 * the user whether anything actually turned up.
 *
 * @public
 * @returns {Array} each `{ address, label, primary }`
 */
export function addresses() {
  const out = [];
  Object.entries(os.networkInterfaces()).forEach(([name, list]) => {
    (list || []).forEach((entry) => {
      if (!entry || entry.family !== 'IPv4') return;
      out.push({
        address: entry.address,
        label: entry.address,
        interface: name,
        internal: !!entry.internal,
      });
    });
  });
  // A routable address first: it serves software on this machine *and* on the
  // network, where loopback serves only this machine. Loopback is the fallback
  // for a laptop with no network at all.
  out.sort((a, b) => Number(a.internal) - Number(b.internal));
  return out.map((a, i) => ({ ...a, primary: i === 0 }));
}

/** The address a laser gets when it has not been given one. */
export function defaultAddress() {
  const list = addresses();
  return list.length ? list[0].address : '127.0.0.1';
}

/** One running device, and the lasers on it. */
const keyOf = (protocol, address) => `${protocol}@${address}`;

class LaserHub {
  /**
   * @param {Object} [options]
   * @param {Object} [options.builders] protocol -> () => device, so a test can
   *   check which devices a show adds up to without binding real sockets
   * @param {Object} [options.ponk] the Ponk receiver, likewise
   */
  constructor({ builders = BUILDERS, ponk = null } = {}) {
    this.builders = builders;
    /** `protocol@address` -> { protocol, address, dac, inputs } */
    this.devices = new Map();
    this.ponk = ponk || new PonkReceiver();
    this.onFrames = null;
    /** Reported back per input, so the fixture can say what happened. */
    this.status = new Map();
  }

  /**
   * Starts what runs whatever the show holds: the Ponk receiver.
   *
   * @public
   * @param {(batch: Object) => void} onFrames
   */
  async start(onFrames) {
    this.onFrames = onFrames;
    try {
      await this.ponk.start((batch) => this.deliver(batch));
    } catch (err) {
      console.error('[laser] Ponk did not start:', err.message);
    }
  }

  /** @public Stops every device. */
  stop() {
    this.devices.forEach((d) => d.dac.stop());
    this.devices.clear();
    this.ponk.stop();
    this.status.clear();
  }

  /** Passes a batch to the renderer, tagged with where it came from. */
  deliver(batch) {
    if (this.onFrames) this.onFrames(batch);
  }

  /**
   * Makes the running devices match what the show asks for.
   *
   * Inputs are taken in order, so when two lasers want the same exclusive
   * device the first one in the show holds it and the second is told which
   * laser has it -- rather than the two of them silently sharing a stream.
   *
   * @public
   * @param {Array} inputs each `{ uid, name, protocol, address, service }`
   * @returns {Array} one `{ uid, ok, reason }` per input
   */
  async configure(inputs) {
    const wanted = new Map();
    const results = [];
    const held = new Map(); // exclusive key -> the laser holding it

    (Array.isArray(inputs) ? inputs : []).forEach((input) => {
      const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'ponk';
      if (protocol === 'ponk') {
        results.push({
          uid: input.uid, ok: true, protocol, address: null, service: null,
        });
        return;
      }
      // Resolved, not as asked: a laser storing null means "the default", and
      // the renderer has to look its stream up under the address the device is
      // really bound to. Answering with the asked-for value left every laser on
      // a default address looking up a stream that arrives under another name,
      // and drawing nothing at all.
      const address = input.address || defaultAddress();
      const key = keyOf(protocol, address);
      if (EXCLUSIVE.includes(protocol)) {
        const owner = held.get(key);
        if (owner) {
          results.push({
            uid: input.uid, ok: false, reason: `${owner} already uses this`, protocol, address,
          });
          return;
        }
        held.set(key, input.name || 'another laser');
      }
      const entry = wanted.get(key) || {
        protocol, address, inputs: [],
      };
      entry.inputs.push(input);
      wanted.set(key, entry);
      results.push({
        uid: input.uid, ok: true, protocol, address, service: input.service || null,
      });
    });

    // Devices nobody asked for any more.
    [...this.devices.keys()].forEach((key) => {
      if (wanted.has(key)) return;
      const device = this.devices.get(key);
      console.log(`[laser] stopping ${key}`);
      device.dac.stop();
      this.devices.delete(key);
    });

    // Start what is new, and tell every IDN unit which lasers it serves.
    const starting = [];
    wanted.forEach((entry, key) => {
      let device = this.devices.get(key);
      if (!device) {
        const dac = this.builders[entry.protocol]();
        device = { ...entry, dac, listening: false };
        this.devices.set(key, device);
        starting.push(
          dac.start(
            (batch) => this.deliver({ ...batch, protocol: entry.protocol, address: entry.address }),
            { bind: entry.address },
          ).then(() => {
            device.listening = true;
          }).catch((err) => {
            console.error(`[laser] ${key} did not start:`, err.message);
            device.error = err.message;
          }),
        );
      }
      device.inputs = entry.inputs;
      // One named service per laser, so a producer that reads the service map
      // shows the fixture's own name.
      if (entry.protocol === 'idn' && device.dac.setServices) {
        device.dac.setServices(entry.inputs.map((i, at) => ({
          id: i.service || at + 1,
          name: i.name || `Laser ${at + 1}`,
        })));
      }
    });
    await Promise.all(starting);

    // A device that could not start is a laser that cannot receive, and the
    // fixture should say so rather than sit dark looking healthy. The usual
    // cause is another program holding the port -- MadMapper itself takes the
    // LaserCube command port on the machine's LAN address.
    results.forEach((result) => {
      if (!result.ok || !result.address) return;
      const device = this.devices.get(keyOf(result.protocol, result.address));
      if (device && device.error) {
        Object.assign(result, { ok: false, reason: device.error });
      }
    });

    results.forEach((r) => this.status.set(r.uid, r));
    return results;
  }

  /**
   * What every device is doing, for the readout.
   *
   * @public
   * @returns {Array}
   */
  report() {
    const out = [this.ponk.report()];
    this.devices.forEach((device, key) => {
      out.push({
        key,
        protocol: device.protocol,
        address: device.address,
        listening: device.listening && !device.error,
        error: device.error || null,
        lasers: device.inputs.map((i) => i.name),
        ...device.dac.report(),
      });
    });
    return out;
  }
}

export default LaserHub;
