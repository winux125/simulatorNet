/**
 * SimulatorNet management plane.
 *
 * Simulated Telnet and SSH remote CLI carried by the deterministic TCP
 * transport in `sim-core`, authenticated against the same device credentials
 * the console uses, and executed by the same `cli-engine` parser. Nothing here
 * touches a real network, a real terminal, or real cryptography: SSH is an
 * educational model with a derived host-key fingerprint, and Telnet carries no
 * option negotiation. Credentials cross the simulated wire only as opaque,
 * scope-bound fingerprints.
 */
export * from "./limits";
export * from "./messages";
export * from "./managed-device";
export * from "./authentication";
export * from "./aaa";
export * from "./vty";
export * from "./service";
export * from "./client";
export * from "./plane";
