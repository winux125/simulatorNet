# Packet Tracer migration

SimulatorNet decodes `.pkt` and `.pka` containers directly — see
[import compatibility](import-compatibility.md). The Migration Assistant
described here is the **fallback** for the files that decoding cannot reach: an
unsupported container version, a failed authentication tag, a corrupt file, or
one refused by a safety limit. The wizard says which of those it was before
offering this path.

The assistant does not decode anything. It reconstructs a lab from data the
user supplies, and it is never used for a container that decoded successfully.

## Assisted reconstruction

Open the Packet Tracer file in the Import Wizard. If it cannot be decoded,
choose **Reconstruct Lab from Companion Files**. You may select:

- one or more bounded PNG, JPEG, or WebP screenshots as diagram references;
- device `.cfg` or `.txt` files (the filename stem is the hostname);
- `devices.csv` and `interfaces.csv` inventories;
- optional `connections.csv` with explicitly confirmed cable endpoints.

The assistant creates a normal `ImportPlan`. Review every proposed device type
in **Map Devices** before importing. The resulting lab opens stopped.

```csv
# devices.csv
hostname,type,x,y
R1,router,320,180
SW1,l2-switch,520,180
PC1,pc,520,340
```

```csv
# interfaces.csv
device,interface,address,mask,gateway
R1,Gi0/0,192.168.10.1,255.255.255.0,
PC1,eth0,192.168.10.10,255.255.255.0,192.168.10.1
```

```csv
# connections.csv
deviceA,interfaceA,deviceB,interfaceB
R1,Gi0/0,SW1,Gi0/1
SW1,Gi0/2,PC1,eth0
```

Connectivity is never guessed from pixels. When `connections.csv` is absent,
the reconstructed topology contains no inferred cables. Screenshots are not
processed with OCR and do not affect simulation or grading.

All processing is local and uses the normal importer limits and text/image
sanitizers. No executable content, external upload, remote converter, shell, or
automatic Packet Tracer extraction is used. Every result report states:

> Reconstructed from user-provided companion data; PKT content was not parsed.
