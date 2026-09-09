# Third-party notices

SimulatorNet bundles no third-party source. This file records external work
that *informed* an implementation here, so the provenance of a format or an
algorithm is auditable rather than folklore.

Every license below was read from the named repository at the named commit, not
inferred from a badge or a README line.

## Cisco Packet Tracer container format

`packages/packet-tracer-format` reads the `.pkt` / `.pka` container. The layer
geometry — the positional XOR masks, the reversal, Twofish-EAX with its fixed
key and nonce, and the Qt `qCompress` framing — was established by reading the
following independent implementations. No code was copied from any of them; the
TypeScript in this repository is our own, and the Twofish and EAX modules are
implemented from their published specifications.

| Project | License | Commit read | What it established |
| --- | --- | --- | --- |
| [jeamxn/cisco-pka-to-xml](https://github.com/jeamxn/cisco-pka-to-xml) | MIT — Copyright (c) 2026 cisco-pka-to-xml contributors | `efe407c41227d097f9469ed941f71371e7314074` | The full modern four-layer pipeline, the fixed key/IV constants, and 7.x–9.x applicability |
| [Punkcake21/Unpacket](https://github.com/Punkcake21/Unpacket) | MIT — Copyright (c) 2026 Punkcake21 | `54cb6d6a9b46c6b4973356258cb8df6ae58b2ec7` | Corroboration of the EAX construction (OMAC 0/1/2, CTR seeded from the nonce MAC) and the `qCompress` length prefix |
| [rodrigodg1/pkt-to-xml](https://github.com/rodrigodg1/pkt-to-xml) | MIT — Copyright (c) 2026 PKT to XML Converter Contributors; itself based on `pka2xml` by @mircodezorzi | `181585f90cfd67102ed62358312d13a3c12b98bb` | The decoded XML's element vocabulary, and the real `.pkt` used as a local compatibility fixture |
| [axcheron/ptexplorer](https://github.com/axcheron/ptexplorer) | MIT — Copyright (c) 2019 Alexandre CHERON | `45fc290cefe6a80dc45f71ad8d6ca903eb74123f` | The pre-7.x legacy container: a single length-keyed XOR ahead of `qCompress` |

### Algorithms

- **Twofish** — implemented from Schneier, Kelsey, Whiting, Wagner, Hall and
  Ferguson, *Twofish: A 128-Bit Block Cipher* (1998). Pinned by the published
  ECB vectors for all three key lengths in `tests/twofish.test.ts`.
- **CMAC / OMAC1** — implemented from NIST SP 800-38B.
- **EAX** — implemented from Bellare, Rogaway and Wagner, *The EAX Mode of
  Operation* (2004).

### What this is not

The container's key and nonce are fixed constants inside Packet Tracer itself.
Reading the format therefore requires no secret and discloses none. SimulatorNet
does not redistribute any Cisco software, asset, activity or course material,
and the importer is strictly one-way: it never writes a `.pkt` or `.pka`.

Real Packet Tracer containers used to verify compatibility are **not** committed
to this repository. They live in the ignored `.local-fixtures/` directory with a
generated provenance record; see `docs/packet-tracer-import.md`.
