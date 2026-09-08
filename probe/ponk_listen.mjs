/* eslint-disable no-console */
/**
 * Ponk receiver probe: who is sending, and is it one stream per laser?
 *
 * Joins MadMapper's Ponk multicast group and prints every distinct sender it
 * hears -- the 32-bit sender identifier and the sender name -- with a running
 * count of frames, paths and points. If MadLaser sends one Ponk stream per
 * laser output, each output shows up here as its own line with its own name.
 * If it does not, there is one line however many outputs there are.
 *
 * Layout from madmappersoftware/Ponk `Common/Cpp/PonkDefs.h`, packed:
 *   char[8] "PONK-UDP", u8 version, u32 senderId, char[32] senderName,
 *   u8 frameNumber, u8 chunkCount, u8 chunkNumber, u32 dataCrc   = 52 bytes
 * then, once the chunks of a frame are joined:
 *   u8 dataFormat, N x { u8 metaCount, meta[metaCount]{char[8],f32},
 *                        u16 pointCount, points... }
 *
 * Usage:
 *   node probe/ponk_listen.mjs
 */
import dgram from 'dgram';
import os from 'os';

const PORT = 5583;
const GROUP = '239.255.10.24';
const HEADER = 52;
const FORMAT_XYRGB_U16 = 0; // 5 x u16 = 10 bytes a point
const FORMAT_XY_F32_RGB_U8 = 1; // 2 x f32 + 3 x u8 = 11 bytes a point

/** sender id -> { name, frames, paths, points, chunks, from, formats } */
const senders = new Map();
/** `${id}:${frame}` -> { count, parts: Map(chunkNumber -> Buffer) } */
const pending = new Map();

function parseFrame(id, data) {
  const s = senders.get(id);
  let at = 0;
  const format = data.readUInt8(at); at += 1;
  s.formats.add(format);
  const stride = format === FORMAT_XYRGB_U16 ? 10 : format === FORMAT_XY_F32_RGB_U8 ? 11 : 0;
  while (at < data.length) {
    const metaCount = data.readUInt8(at); at += 1;
    const metas = [];
    for (let i = 0; i < metaCount; i += 1) {
      const key = data.toString('ascii', at, at + 8).replace(/\0+$/, '');
      const value = data.readFloatLE(at + 8);
      metas.push(`${key}=${value}`);
      at += 12;
    }
    const pointCount = data.readUInt16LE(at); at += 2;
    s.paths += 1;
    s.points += pointCount;
    if (metas.length && !s.metaSeen) { s.metaSeen = metas.join(' '); }
    if (!stride) { s.badFormat = format; break; }
    at += pointCount * stride;
  }
  s.frames += 1;
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('message', (msg, rinfo) => {
  if (msg.length < HEADER || msg.toString('ascii', 0, 8) !== 'PONK-UDP') return;
  const version = msg.readUInt8(8);
  const id = msg.readUInt32LE(9);
  const name = msg.toString('utf8', 13, 45).replace(/\0.*$/, '');
  const frame = msg.readUInt8(45);
  const chunkCount = msg.readUInt8(46);
  const chunkNumber = msg.readUInt8(47);
  let s = senders.get(id);
  if (!s) {
    s = {
      name, version, frames: 0, paths: 0, points: 0, chunks: 0, formats: new Set(),
      from: `${rinfo.address}:${rinfo.port}`, metaSeen: '',
    };
    senders.set(id, s);
    console.log(`NEW SENDER  id=0x${id.toString(16).padStart(8, '0')}  name="${name}"  from ${s.from}  version ${version}`);
  } else if (s.name !== name) {
    console.log(`RENAMED     id=0x${id.toString(16)}  "${s.name}" -> "${name}"`);
    s.name = name;
  }
  s.chunks += 1;
  const key = `${id}:${frame}`;
  let p = pending.get(key);
  if (!p) { p = { count: chunkCount, parts: new Map() }; pending.set(key, p); }
  p.parts.set(chunkNumber, msg.subarray(HEADER));
  if (p.parts.size === p.count) {
    const ordered = [...p.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    pending.delete(key);
    try { parseFrame(id, Buffer.concat(ordered)); } catch (e) { s.parseError = e.message; }
  }
  if (pending.size > 64) pending.clear();
});

socket.bind(PORT, () => {
  socket.setMulticastLoopback(true);
  const ifaces = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4');
  ifaces.forEach((i) => {
    try { socket.addMembership(GROUP, i.address); console.log(`joined ${GROUP} on ${i.address}`); } catch (e) { console.log(`no join on ${i.address}: ${e.message}`); }
  });
  console.log(`listening for Ponk on :${PORT}\n`);
});

let lastReport = '';
setInterval(() => {
  if (!senders.size) return;
  const lines = [...senders.entries()].map(([id, s]) => `  0x${id.toString(16).padStart(8, '0')}  "${s.name.padEnd(24)}"  frames ${String(s.frames).padStart(6)}  paths ${String(s.paths).padStart(6)}  points ${String(s.points).padStart(8)}  chunks ${s.chunks}  fmt ${[...s.formats].join(',')}${s.badFormat !== undefined ? ` UNKNOWN FORMAT ${s.badFormat}` : ''}${s.parseError ? ` PARSE ERROR ${s.parseError}` : ''}${s.metaSeen ? `  meta: ${s.metaSeen}` : ''}`);
  const report = lines.join('\n');
  if (report === lastReport) return;
  lastReport = report;
  console.log(`--- ${new Date().toISOString().slice(11, 19)}  ${senders.size} sender(s)\n${report}`);
}, 2000);
