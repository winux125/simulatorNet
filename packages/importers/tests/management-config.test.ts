import { describe, expect, it } from "vitest";
import { managementCredentialScope, createManagementCredentialVerifier } from "@sim/console-auth";
import {
  deriveManagementSecrets,
  parseManagementConfigFromIos,
  redactManagementSecrets,
} from "../src";

const CONFIG = `
hostname SW1
!
vlan 10
 name MGMT
!
interface Vlan10
 description Management
 ip address 192.168.10.2 255.255.255.0
 no shutdown
!
ip default-gateway 192.168.10.1
ip domain-name lab.local
crypto key generate rsa modulus 2048
ip ssh version 2
!
aaa new-model
aaa authentication login default group radius local
aaa authentication login VTY_LOGIN group tacacs+ local
aaa authorization exec default group tacacs+ local
aaa authorization commands 15 default group tacacs+ local
aaa accounting exec default start-stop group radius
aaa accounting commands 15 default start-stop group tacacs+
aaa server radius dynamic-author
!
radius server RAD1
 address ipv4 192.168.50.10 auth-port 1812 acct-port 1813
 key SuperSecretRadius
 timeout 4
!
tacacs server TAC1
 address ipv4 192.168.50.10
 key SuperSecretTacacs
!
line vty 0 4
 login local
 transport input ssh
 exec-timeout 10 0
 login authentication VTY_LOGIN
!
line vty 5 15
 login
 password LinePassword
 transport input telnet ssh
`;

describe("IOS management and AAA import", () => {
  it("maps the management SVI, default gateway and SSH settings", () => {
    const parsed = parseManagementConfigFromIos(CONFIG);
    expect(parsed.managementSvi).toEqual({
      vlanId: 10,
      ipAddress: "192.168.10.2",
      prefixLength: 24,
      adminUp: true,
      description: "Management",
    });
    expect(parsed.managementDefaultGateway).toBe("192.168.10.1");
    expect(parsed.remoteAccess?.ssh).toMatchObject({ domainName: "lab.local", version: 2, modulusBits: 2_048 });
  });

  it("maps VTY lines with login mode, transports and exec-timeout", () => {
    const parsed = parseManagementConfigFromIos(CONFIG);
    expect(parsed.remoteAccess?.vtyLines).toEqual([
      expect.objectContaining({
        first: 0,
        last: 4,
        loginMode: "local",
        transports: ["ssh"],
        execTimeoutSeconds: 600,
        authenticationListName: "VTY_LOGIN",
      }),
      expect.objectContaining({ first: 5, last: 15, loginMode: "password", transports: ["telnet", "ssh"] }),
    ]);
  });

  it("maps AAA method lists in order and keeps the first conclusive semantics", () => {
    const parsed = parseManagementConfigFromIos(CONFIG);
    expect(parsed.aaa?.enabled).toBe(true);
    expect(parsed.aaa?.authenticationLogin).toEqual([
      { name: "default", methods: ["group radius", "local"] },
      { name: "VTY_LOGIN", methods: ["group tacacs+", "local"] },
    ]);
    expect(parsed.aaa?.authorizationCommands).toEqual([
      { name: "default", privilegeLevel: 15, methods: ["group tacacs+", "local"] },
    ]);
    expect(parsed.aaa?.accountingExec).toEqual([
      { name: "default", mode: "start-stop", methods: ["group radius"] },
    ]);
  });

  it("maps RADIUS and TACACS+ servers with their ports and timeouts", () => {
    const parsed = parseManagementConfigFromIos(CONFIG);
    expect(parsed.aaa?.servers).toEqual([
      expect.objectContaining({
        name: "RAD1",
        protocol: "radius",
        address: "192.168.50.10",
        authenticationPort: 1812,
        accountingPort: 1813,
        timeoutSeconds: 4,
      }),
      expect.objectContaining({ name: "TAC1", protocol: "tacacs+", address: "192.168.50.10" }),
    ]);
  });

  it("converts plaintext keys and line passwords into scope-bound verifiers", async () => {
    const derived = await deriveManagementSecrets(CONFIG, parseManagementConfigFromIos(CONFIG));
    const expectedRadius = await createManagementCredentialVerifier(
      managementCredentialScope.sharedKey("RAD1"),
      "SuperSecretRadius",
    );
    expect(derived.aaa?.servers.find((server) => server.name === "RAD1")?.sharedKeyFingerprint)
      .toBe(expectedRadius.hashBase64);

    const line = derived.remoteAccess?.vtyLines.find((entry) => entry.first === 5);
    const expectedLine = await createManagementCredentialVerifier(
      managementCredentialScope.line("vty"),
      "LinePassword",
    );
    expect(line?.passwordVerifier?.hashBase64).toBe(expectedLine.hashBase64);

    // The plaintext never survives anywhere in the converted configuration.
    const serialized = JSON.stringify(derived);
    expect(serialized).not.toContain("SuperSecretRadius");
    expect(serialized).not.toContain("SuperSecretTacacs");
    expect(serialized).not.toContain("LinePassword");
  });

  it("reports advanced AAA syntax it does not simulate instead of dropping it", () => {
    const parsed = parseManagementConfigFromIos(CONFIG);
    expect(parsed.ignored).toContain("aaa server radius dynamic-author");
  });

  it("flags a vendor hash as requiring a reset rather than importing it", () => {
    const parsed = parseManagementConfigFromIos(`
radius server RAD1
 address ipv4 10.0.0.1
 key 7 070C285F4D06
`);
    expect(parsed.resetRequired).toBe(true);
    expect(parsed.aaa?.servers[0]?.sharedKeyFingerprint).toBeUndefined();
  });

  it("redacts keys and communities from preserved artifact text", () => {
    const redacted = redactManagementSecrets(CONFIG);
    expect(redacted).not.toContain("SuperSecretRadius");
    expect(redacted).not.toContain("SuperSecretTacacs");
    expect(redacted).toContain("key <redacted>");
  });
});
