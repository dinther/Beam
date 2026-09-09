/* eslint-disable no-console */
/**
 * Which devices the show's lasers add up to.
 *
 * A laser says how it wants to be fed -- a protocol, and for a DAC the address
 * its device lives at -- and the hub turns that list into running devices. The
 * rules that matter are about how many lasers a protocol can carry, and they
 * are not arbitrary: Ether Dream and LaserCube identify a device by its
 * address and carry no name, so one laser may hold one address; IDN offers a
 * named service per laser, so a whole rig fits at one address; Ponk is
 * received rather than advertised and has no address at all.
 *
 * The failure this pins is a quiet one. Two lasers both claiming the same
 * Ether Dream would silently share one stream and draw the same figure, which
 * looks like a rendering bug and is not. The second laser is refused and told
 * which one holds it.
 *
 * Usage:
 *   npm test
 */
import LaserHub, {
  addresses, defaultAddress, PROTOCOLS, EXCLUSIVE,
} from '@/electron/laser_hub';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/**
 * A hub whose devices are stubs.
 *
 * Nothing here touches the network: what is under test is which devices a
 * show adds up to, not whether a socket binds. Real DACs would also fight each
 * other for ports across the cases below and make the results depend on order.
 */
function fakeHub() {
  const stub = () => ({
    start: async () => {}, stop: () => {}, setServices() {}, report: () => ({}),
  });
  return new LaserHub({
    builders: { etherdream: stub, lasercube: stub, idn: stub },
    ponk: { start: async () => {}, stop: () => {}, report: () => ({ protocol: 'ponk' }) },
  });
}

const laser = (uid, protocol, address = null, name = uid, service = null) => ({
  uid,
  protocol,
  address,
  name,
  service,
});

console.log('\n-- the addresses a device may live at --');

{
  const list = addresses();
  check('at least one address', list.length > 0, true);
  check('every one is IPv4 text', list.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a.address)), true);
  check('exactly one is primary', list.filter((a) => a.primary).length, 1);
  // A routable address serves software on this machine and on the network;
  // loopback serves only this machine, so it is the fallback, not the default.
  const primary = list.find((a) => a.primary);
  const routable = list.some((a) => !a.internal);
  check('the default is routable when one exists', routable ? !primary.internal : true, true);
  check('defaultAddress is that one', defaultAddress(), primary.address);
}

console.log('\n-- protocols, and which of them are exclusive --');

check('four protocols', PROTOCOLS.join(), 'ponk,idn,etherdream,lasercube');
check('two are exclusive', EXCLUSIVE.join(), 'etherdream,lasercube');
check('IDN is not, because services name its lasers', EXCLUSIVE.includes('idn'), false);
check('Ponk is not, because it is received', EXCLUSIVE.includes('ponk'), false);

console.log('\n-- a rig of Ponk lasers needs no devices at all --');

{
  const hub = fakeHub();
  const results = await hub.configure([
    laser('a', 'ponk'), laser('b', 'ponk'), laser('c', 'ponk'),
  ]);
  check('every one accepted', results.every((r) => r.ok), true);
  check('and nothing was started', hub.devices.size, 0);
}

console.log('\n-- one IDN unit carries a whole rig --');

{
  const hub = fakeHub();
  const results = await hub.configure([
    laser('a', 'idn', '127.0.0.1', 'Front Left', 1),
    laser('b', 'idn', '127.0.0.1', 'Front Right', 2),
    laser('c', 'idn', '127.0.0.1', 'Rear', 3),
  ]);
  check('all three accepted', results.every((r) => r.ok), true);
  check('one device for the three', hub.devices.size, 1);
  const device = [...hub.devices.values()][0];
  check('and it serves all of them', device.inputs.length, 3);
  check('under their own names', device.inputs.map((i) => i.name).join(), 'Front Left,Front Right,Rear');
}

console.log('\n-- an Ether Dream is one laser, and the second is told why --');

{
  const hub = fakeHub();
  const results = await hub.configure([
    laser('a', 'etherdream', '127.0.0.1', 'Front Left'),
    laser('b', 'etherdream', '127.0.0.1', 'Front Right'),
  ]);
  check('the first holds it', results[0].ok, true);
  check('the second is refused', results[1].ok, false);
  check('and told which laser has it', results[1].reason, 'Front Left already uses this');
  check('only one device exists', hub.devices.size, 1);
  // A second address is the way out, and it is the user's choice to make.
  const hub2 = fakeHub();
  const spread = await hub2.configure([
    laser('a', 'etherdream', '127.0.0.1', 'Front Left'),
    laser('b', 'etherdream', '192.168.1.2', 'Front Right'),
  ]);
  check('two addresses, two lasers', spread.every((r) => r.ok), true);
  check('and two devices', hub2.devices.size, 2);
}

console.log('\n-- the same address serves different protocols at once --');

{
  const hub = fakeHub();
  const results = await hub.configure([
    laser('a', 'etherdream', '127.0.0.1', 'One'),
    laser('b', 'lasercube', '127.0.0.1', 'Two'),
    laser('c', 'idn', '127.0.0.1', 'Three', 1),
  ]);
  check('all three accepted', results.every((r) => r.ok), true);
  check('three devices', hub.devices.size, 3);
}

console.log('\n-- reconfiguring stops what nobody asked for --');

{
  const hub = fakeHub();
  await hub.configure([laser('a', 'idn', '127.0.0.1', 'One', 1), laser('b', 'etherdream', '127.0.0.1', 'Two')]);
  check('two devices', hub.devices.size, 2);
  const keptDevice = hub.devices.get('idn@127.0.0.1');
  await hub.configure([laser('a', 'idn', '127.0.0.1', 'One', 1)]);
  check('the unwanted one is gone', hub.devices.size, 1);
  check('and the kept one was not restarted', hub.devices.get('idn@127.0.0.1') === keptDevice, true);
  await hub.configure([]);
  check('an empty show runs nothing', hub.devices.size, 0);
}

console.log('\n-- every device carries an identity of its own --');

{
  // A host recognises a device by what it advertises, not by the address it
  // answers from: two Ether Dreams built from the defaults are one MAC seen
  // twice, and MadMapper showed a single destination for a rig of two.
  const built = [];
  const spy = (address) => {
    built.push(address);
    return {
      address,
      start: async () => {},
      stop: () => {},
      setServices() {},
      report: () => ({}),
    };
  };
  const hub = new LaserHub({
    builders: { etherdream: spy, lasercube: spy, idn: spy },
    ponk: { start: async () => {}, stop: () => {}, report: () => ({ protocol: 'ponk' }) },
  });
  await hub.configure([
    laser('a', 'etherdream', '127.0.0.1', 'Left'),
    laser('b', 'etherdream', '192.168.1.2', 'Right'),
  ]);
  check('each device is built for its own address', built.join(), '127.0.0.1,192.168.1.2');
  const ids = [...hub.devices.values()].map((d) => d.dac.address).sort();
  check('and holds it', ids.join(), '127.0.0.1,192.168.1.2');
}

console.log('\n-- a device that cannot own its ports is refused, with the reason --');

{
  // The real case: MadMapper holds the LaserCube command port on this
  // machine's LAN address, so a `reuseAddr` bind succeeds and then receives
  // nothing. A device that cannot start must say so, or the fixture shows a
  // healthy input that can never draw.
  const failing = () => ({
    start: async () => {
      throw new Error('UDP port 45457 on 192.168.1.2 is already in use');
    },
    stop: () => {},
    setServices() {},
    report: () => ({}),
  });
  const hub = new LaserHub({
    builders: { lasercube: failing, etherdream: failing, idn: failing },
    ponk: { start: async () => {}, stop: () => {}, report: () => ({ protocol: 'ponk' }) },
  });
  const results = await hub.configure([laser('a', 'lasercube', '192.168.1.2', 'Right')]);
  check('the laser is not ok', results[0].ok, false);
  check('and names the port it lost', results[0].reason.includes('45457'), true);
}

console.log('\n-- a laser with no address gets the default --');

{
  const hub = fakeHub();
  await hub.configure([laser('a', 'idn', null, 'One', 1)]);
  check('bound to the default address', hub.devices.has(`idn@${defaultAddress()}`), true);
  check('an unknown protocol falls back to Ponk', (await hub.configure([laser('b', 'nonsense')]))[0].ok, true);
  check('and starts nothing', hub.devices.size, 0);
}

console.log(`\n${failures ? `${failures} failed` : 'all passed'}`);
if (failures) process.exit(1);
