# MadMapper: please send the IDN service ID (and ask for the service map)

**Summary.** MadMapper implements IDN discovery and streaming, but not IDN
*services*. It never sends `IDN-Hello` **service map request** (0x12), and every
outgoing channel configuration carries **service ID 0** whatever destination the
user picked. The consequence is that a consumer offering several lasers behind
one address cannot tell which of its lasers a stream is for — the information
exists in the protocol and MadMapper simply does not send it.

This is a small change on your side with a large payoff for anyone writing an
IDN consumer, and it is the difference between MadMapper driving one virtual
laser and driving a whole rig.

---

## What we observed

Measured against Beam (a lighting/laser visualiser) acting as an IDN consumer,
MadMapper 5.x on Windows, over several sessions:

| Observation | Measurement |
|---|---|
| Service map requested | **0 requests** across 73 discovery scans |
| Service ID in channel configuration | **always 0**, for every output |
| Channel ID | **always 0**, for every output |
| Unit label in the destination dropdown | `IDN 01-<hex>` — the unit ID; the host name in the scan response is not shown |

Discovery itself works well: units are found quickly and reliably, and two
units at two addresses appear as two distinct destinations.

## Why it matters

A consumer that stands in for several lasers has no way to route the streams.
The only thing that differs between MadMapper's outputs is the **UDP source
port**, so a consumer is reduced to pairing streams to lasers by arrival order
and hoping. That is not a stable mapping: the ports change whenever MadMapper
restarts, and there is no correct answer for three or more lasers.

The workarounds are all bad:

- **One IP address per laser.** This does work — we verified two MadMapper
  outputs landing cleanly on two units at two addresses. But it asks the user
  to add IP addresses to their network adapter, which is not something a
  visualiser can reasonably require.
- **Publishing to Ponk instead.** Ponk carries a name per output and solves
  identity completely. But Ponk is the geometry *before* your ILDA rasteriser:
  a single circle arrives as **8,146 points per frame at 60 fps** (~5.4 MB/s
  per stream), where the same shape through the laser path is **500 points** at
  30 kpps. It also has no dwell information, so a consumer must model the
  scanner's brightness rather than receive it.

Neither is necessary. IDN already defines the answer.

## What we are asking for

Three changes, in order of value:

1. **Send the service ID the user selected** in the IDN-Stream channel
   configuration header (octet 2), rather than 0.
2. **Request the service map** (`IDN-Hello` command 0x12) after discovery, and
   offer its services as destinations.
3. **Show the service name**, and the unit's host name from the scan response,
   in the destination list. `IDN.<unit>.<service>` is what other IDN consumers
   display and it is far more usable than a hex unit ID.

(1) alone would be enough to unblock every consumer that offers more than one
laser. (2) and (3) make it discoverable and readable for the user.

## It already works on the other side

Beam implements the consumer half today — service map responses and routing by
service ID. A reference producer of about 90 lines, doing what is asked above,
drives two named lasers through one unit at one address:

```
1. SCAN_RESPONSE: unit "Front Left"
2. MAP_RESPONSE: 2 service(s)
     id 1  "Front Left"
     id 2  "Front Right"
3. points delivered, by service:
     service 1 (Front Left):  10 points
     service 2 (Front Right): 30 points
```

Each stream reached the laser it was addressed to, from one socket, with no
network configuration. We are happy to share that reference producer.

## Smaller things found along the way

These are minor, and noted only because we hit them:

- **The Ponk specification contradicts itself.** `Common/Cpp/PonkDefs.h` places
  the data-format byte once at the front of a packet's data; the README lists
  it inside "for each path". The stream follows the README. Reading it the
  header's way decodes a single-path frame perfectly and rejects every frame
  with two or more paths, which is invisible until someone sends a dashed line
  or a masked shape. One of the two documents wants a correction.

- **Ponk sampling density.** It would help receivers a great deal if Ponk
  sampled at something closer to what a laser can scan, or if the publish
  resolution were exposed per output. See the point counts above.

- **Stale IDN destinations.** Units that stop answering remain in the
  destination dropdown until MadMapper is restarted.

---

*Contact: Paul van Dinther, Beatline — Beam laser visualiser.*
*Everything above is measured, and we can supply captures and the reference
producer on request.*
