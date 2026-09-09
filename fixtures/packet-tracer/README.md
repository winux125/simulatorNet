# Packet Tracer synthetic-format fixtures

The `.pkt` and `.pka` files in this directory are **synthetic-format
fixtures**. They were produced by SimulatorNet's own test encoder
(`packages/packet-tracer-format/tests/helpers/encode.ts`) and carry XML written
by this project, listed in [`sources.ts`](sources.ts).

They are **not** files written by Cisco Packet Tracer, and they must never be
described as such. No Cisco file, activity, course material or asset is
redistributed here.

## What they prove

They have the real container geometry — Qt `qCompress` framing, the positional
masks, Twofish-EAX with the container key and nonce — so they exercise:

- the decoder end to end on frozen bytes, including tag authentication;
- the parser against the real element vocabulary (`PACKETTRACER5`,
  `DEVICES/DEVICE/ENGINE`, ordered `CABLE` endpoints, `RUNNINGCONFIG` lines);
- the mapping onto SimulatorNet devices, interfaces and configuration;
- the import wizard and its `.pka` network chooser, in Vitest and Playwright.

## What they do not prove

They cannot prove compatibility with Cisco's own XML, because the XML is ours.
Only a container genuinely written by Packet Tracer can do that. That is a
separate, deliberately local gate:

```bash
# place real .pkt / .pka files here (the directory is git-ignored)
ls .local-fixtures/packet-tracer/

pnpm test:packet-tracer:real
```

That command **fails** when no real fixture is present, rather than skipping
quietly, so the absence of the gate can never be mistaken for it passing. Real
binaries are not committed: their provenance and licensing belong to whoever
created the lab, and a repository LICENSE does not extend to a Cisco-copyrighted
activity bundled inside it. Provenance for whatever is placed there is recorded
in `.local-fixtures/packet-tracer/real-fixtures.json`.

## Regenerating

After editing `sources.ts`:

```bash
PACKET_TRACER_WRITE_FIXTURES=1 npx vitest run packages/packet-tracer-format/tests/fixtures.test.ts
```

The same suite, run normally, asserts each committed container decodes back to
its declared source. It does not pin the exact bytes — deflate output belongs to
whatever zlib the runtime ships, and pinning it would fail for reasons unrelated
to this decoder.
