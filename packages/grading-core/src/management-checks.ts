import type { GradingCheck } from "@sim/contracts/grading";
import type { LabDocument } from "@sim/contracts";
import type { BuiltLab } from "@sim/lab-format";
import { createCliSession } from "@sim/cli-engine";
import {
  EndHost,
  L2Switch,
  mibVarBinds,
  deviceMibSource,
  Router,
  Server,
  type SnmpVarBind,
} from "@sim/sim-core";

/**
 * Management-plane grading.
 *
 * These checks drive the *same* simulated path a learner uses: a scripted
 * login opens a real TCP session, authenticates through the real method list
 * and runs a command through the real CLI. Credentials never appear in a
 * grading spec: the verifier is trusted with the rebuilt lab, so it logs in
 * with the credential fingerprint already stored on the device.
 */
export type ManagementCheck = Extract<
  GradingCheck,
  { type:
    | "remote-service-enabled"
    | "vty-transport"
    | "ssh-session-established"
    | "telnet-session-established"
    | "aaa-method-list"
    | "radius-authentication"
    | "tacacs-authentication"
    | "command-authorized"
    | "command-denied"
    | "snmp-agent-configured"
    | "snmp-value"
    | "snmp-trap-received" }
>;

export interface ManagementOutcome {
  readonly passed: boolean;
  readonly message: string;
  /** Bounded, sanitized diagnostics. Never a secret or a hidden expectation. */
  readonly diagnostics: Record<string, unknown>;
  readonly error?: string;
}

export function isManagementCheck(check: GradingCheck): check is ManagementCheck {
  return check.type === "remote-service-enabled"
    || check.type === "vty-transport"
    || check.type === "ssh-session-established"
    || check.type === "telnet-session-established"
    || check.type === "aaa-method-list"
    || check.type === "radius-authentication"
    || check.type === "tacacs-authentication"
    || check.type === "command-authorized"
    || check.type === "command-denied"
    || check.type === "snmp-agent-configured"
    || check.type === "snmp-value"
    || check.type === "snmp-trap-received";
}

function managedDevice(built: BuiltLab, deviceId: string): L2Switch | Router | undefined {
  const device = built.getDevice(deviceId);
  return device instanceof L2Switch || device instanceof Router ? device : undefined;
}

/**
 * Drive one scripted remote login through the real management path and return
 * the transcript it produced. The stored credential fingerprint is replayed, so
 * no plaintext password is required — or even representable — here.
 */
function remoteLogin(
  built: BuiltLab,
  document: LabDocument,
  runUntilIdle: () => void,
  options: {
    readonly clientDeviceId: string;
    readonly targetAddress: string;
    readonly username: string;
    readonly protocol: "telnet" | "ssh";
    readonly targetDeviceId: string;
    readonly command?: string;
  },
): { readonly authenticated: boolean; readonly transcript: string; readonly error?: string } {
  const client = built.getDevice(options.clientDeviceId);
  if (!(client instanceof EndHost)) {
    return { authenticated: false, transcript: "", error: `Device '${options.clientDeviceId}' cannot open a remote session` };
  }
  const target = managedDevice(built, options.targetDeviceId);
  const fingerprint = credentialFingerprintOf(document, options.targetDeviceId, options.username);
  if (!target) {
    return { authenticated: false, transcript: "", error: `Device '${options.targetDeviceId}' has no management plane` };
  }
  const session = createCliSession(client, built.engine);
  session.useRemoteSessionOpener(built.management);
  const lines: string[] = [];
  try {
    lines.push(session.execute(
      options.protocol === "ssh"
        ? `ssh ${options.username}@${options.targetAddress}`
        : `telnet ${options.targetAddress}`,
    ));
    runUntilIdle();
    // SSH asks the client to confirm an unknown host key first.
    if (session.prompt() === "Continue connecting (yes/no)?") {
      lines.push(session.execute("yes"));
      runUntilIdle();
    }
    if (session.prompt() === "Username:") {
      lines.push(session.execute(options.username));
      runUntilIdle();
    }
    if (session.expectsSecret()) {
      lines.push(session.execute("", fingerprint ?? ""));
      runUntilIdle();
    }
    const authenticated = session.remoteSession() !== undefined
      && session.prompt() !== "Username:"
      && session.prompt() !== "Password:";
    if (authenticated && options.command) {
      lines.push(session.execute(options.command));
      runUntilIdle();
    }
    return { authenticated, transcript: lines.filter((line) => line.length > 0).join("\n") };
  } catch (error) {
    return {
      authenticated: false,
      transcript: lines.join("\n"),
      error: error instanceof Error ? error.message : "Remote login failed",
    };
  } finally {
    session.closeRemoteSession();
  }
}

/**
 * The stored, opaque credential of a local user on the target device.
 *
 * The verifier rebuilds the submitted lab, so it already holds the fingerprint
 * the learner configured. A grading spec therefore never has to carry — and can
 * never leak — a password.
 */
function credentialFingerprintOf(
  document: LabDocument,
  deviceId: string,
  username: string,
): string | undefined {
  const config = document.configurations[deviceId];
  if (!config || !("consoleAccess" in config)) return undefined;
  return config.consoleAccess?.users.find((user) => user.enabled && user.username === username)
    ?.credentialFingerprint;
}

function snmpValues(built: BuiltLab, deviceId: string): SnmpVarBind[] {
  const device = managedDevice(built, deviceId);
  return device ? mibVarBinds(deviceMibSource(device, device.snmp)) : [];
}

export function runManagementCheck(
  check: ManagementCheck,
  built: BuiltLab,
  document: LabDocument,
  runUntilIdle: () => void,
): ManagementOutcome {
  switch (check.type) {
    case "remote-service-enabled": {
      const service = built.management.serviceOf(check.configuration.deviceId);
      if (!service) {
        return fail(`Device '${check.configuration.deviceId}' has no management plane`, {}, true);
      }
      const actual = check.configuration.service === "ssh" ? service.sshEnabled : service.telnetEnabled;
      const passed = actual === check.configuration.expected;
      return {
        passed,
        message: `${check.configuration.service.toUpperCase()} is ${actual ? "enabled" : "disabled"}`,
        diagnostics: { actual, expected: check.configuration.expected },
      };
    }
    case "vty-transport": {
      const lines = built.management.linesOf(check.configuration.deviceId);
      const line = lines.find((entry) => entry.index === check.configuration.line);
      if (!line) {
        return fail(`VTY line ${check.configuration.line} is not configured`, { configuredLines: lines.length });
      }
      const actual = [...line.transports].sort();
      const expected = [...check.configuration.expected].sort();
      const transportsMatch = actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
      const loginMatches = check.configuration.loginMode === undefined
        || check.configuration.loginMode === line.loginMode;
      return {
        passed: transportsMatch && loginMatches,
        message: `VTY line ${line.index} permits ${actual.length === 0 ? "no transports" : actual.join(", ")} with login ${line.loginMode}`,
        diagnostics: { transports: actual, loginMode: line.loginMode },
      };
    }
    case "ssh-session-established":
    case "telnet-session-established": {
      const outcome = remoteLogin(built, document, runUntilIdle, {
        clientDeviceId: check.configuration.clientDeviceId,
        targetAddress: check.configuration.targetAddress,
        username: check.configuration.username,
        targetDeviceId: check.configuration.targetDeviceId,
        protocol: check.type === "ssh-session-established" ? "ssh" : "telnet",
      });
      const expectedSuccess = check.configuration.expected === "success";
      return {
        passed: outcome.authenticated === expectedSuccess,
        message: outcome.authenticated
          ? `${check.configuration.username} opened a remote session on ${check.configuration.targetAddress}`
          : `No remote session was established with ${check.configuration.targetAddress}`,
        diagnostics: { authenticated: outcome.authenticated, expected: check.configuration.expected },
        error: outcome.error,
      };
    }
    case "aaa-method-list": {
      const device = managedDevice(built, check.configuration.deviceId);
      if (!device) return fail(`Device '${check.configuration.deviceId}' has no AAA plane`, {}, true);
      const config = device.aaa.snapshot();
      const lists = {
        "authentication-login": config.authenticationLogin,
        "authorization-exec": config.authorizationExec,
        "authorization-commands": config.authorizationCommands,
        "accounting-exec": config.accountingExec,
        "accounting-commands": config.accountingCommands,
      }[check.configuration.purpose];
      const list = lists.find((entry) =>
        entry.name === check.configuration.listName
        && (check.configuration.privilegeLevel === undefined
          || (entry as { privilegeLevel?: number }).privilegeLevel === check.configuration.privilegeLevel));
      if (!list) {
        return fail(`No ${check.configuration.purpose} list named '${check.configuration.listName}'`, {
          aaaEnabled: config.enabled,
        });
      }
      const matches = list.methods.length === check.configuration.expectedMethods.length
        && list.methods.every((method, index) => method === check.configuration.expectedMethods[index]);
      return {
        passed: config.enabled && matches,
        message: `${check.configuration.purpose} ${list.name}: ${list.methods.join(", ")}`,
        diagnostics: { aaaEnabled: config.enabled, methods: [...list.methods] },
      };
    }
    case "radius-authentication":
    case "tacacs-authentication": {
      const outcome = remoteLogin(built, document, runUntilIdle, {
        clientDeviceId: check.configuration.clientDeviceId,
        targetAddress: check.configuration.targetAddress,
        username: check.configuration.username,
        targetDeviceId: check.configuration.targetDeviceId,
        protocol: "telnet",
      });
      const expectedSuccess = check.configuration.expected === "success";
      const status = built.management.aaaStatus(check.configuration.targetDeviceId);
      const method = status?.lastAuthentication?.method;
      const wanted = check.type === "radius-authentication" ? "group radius" : "group tacacs+";
      const viaWantedMethod = method === wanted;
      return {
        passed: outcome.authenticated === expectedSuccess && (!expectedSuccess || viaWantedMethod),
        message: outcome.authenticated
          ? `${check.configuration.username} authenticated via ${method ?? "an unknown method"}`
          : `${check.configuration.username} was not authenticated`,
        diagnostics: { authenticated: outcome.authenticated, method, expected: check.configuration.expected },
        error: outcome.error,
      };
    }
    case "command-authorized":
    case "command-denied": {
      const outcome = remoteLogin(built, document, runUntilIdle, {
        clientDeviceId: check.configuration.clientDeviceId,
        targetAddress: check.configuration.targetAddress,
        username: check.configuration.username,
        targetDeviceId: check.configuration.targetDeviceId,
        protocol: "telnet",
        command: check.configuration.command,
      });
      if (!outcome.authenticated) {
        return fail(`${check.configuration.username} could not open a session to run the command`, {}, true);
      }
      const denied = outcome.transcript.includes("% Authorization failed.");
      const passed = check.type === "command-denied" ? denied : !denied;
      return {
        passed,
        // The command text is echoed, never a hidden policy or a secret.
        message: denied
          ? `'${check.configuration.command}' was denied by command authorization`
          : `'${check.configuration.command}' was authorized`,
        diagnostics: { denied },
        error: outcome.error,
      };
    }
    case "snmp-agent-configured": {
      const device = managedDevice(built, check.configuration.deviceId);
      if (!device) return fail(`Device '${check.configuration.deviceId}' has no SNMP agent`, {}, true);
      const config = device.snmp.snapshot();
      const hasCommunity = config.communities.some((entry) => entry.enabled);
      const checks: boolean[] = [
        config.enabled,
        !check.configuration.expectCommunity || hasCommunity,
        check.configuration.expectTraps === undefined || config.trapsEnabled === check.configuration.expectTraps,
        check.configuration.location === undefined || config.location === check.configuration.location,
        check.configuration.contact === undefined || config.contact === check.configuration.contact,
      ];
      return {
        passed: checks.every(Boolean),
        message: config.enabled
          ? `SNMP agent enabled with ${config.communities.length} community profile(s)`
          : "SNMP agent is not enabled",
        // Community *counts* and flags only: never a community string or its
        // fingerprint, in either a student or an instructor result.
        diagnostics: {
          enabled: config.enabled,
          communityConfigured: hasCommunity,
          trapsEnabled: config.trapsEnabled,
          location: config.location,
          contact: config.contact,
        },
      };
    }
    case "snmp-value": {
      const values = snmpValues(built, check.configuration.deviceId);
      const bind = values.find((entry) => entry.oid === check.configuration.oid);
      if (!bind) {
        return fail(`OID ${check.configuration.oid} is not present in the built-in MIB`, {
          availableObjects: values.length,
        });
      }
      const actual = String(bind.value);
      return {
        passed: actual === check.configuration.expectedValue,
        message: `${check.configuration.oid} = ${bind.type}: ${actual}`,
        diagnostics: { actual, type: bind.type },
      };
    }
    case "snmp-trap-received": {
      const manager = built.getDevice(check.configuration.managerDeviceId);
      if (!(manager instanceof Server)) {
        return fail(`Device '${check.configuration.managerDeviceId}' is not a Network Management server`, {}, true);
      }
      const traps = manager.services.networkManagement.runtimeSnapshot().traps;
      const matching = traps.filter((trap) =>
        trap.trapType === check.configuration.trapType
        && (check.configuration.sourceDeviceId === undefined
          || trap.sourceDeviceId === check.configuration.sourceDeviceId)
        && (check.configuration.interfaceId === undefined
          || trap.varBinds.some((bind) => String(bind.value) === check.configuration.interfaceId)));
      return {
        passed: matching.length > 0,
        message: matching.length > 0
          ? `${matching.length} ${check.configuration.trapType} trap(s) received`
          : `No ${check.configuration.trapType} trap was received`,
        diagnostics: { matching: matching.length, totalTraps: traps.length },
      };
    }
  }
}

function fail(message: string, diagnostics: Record<string, unknown>, isError = false): ManagementOutcome {
  return { passed: false, message, diagnostics, error: isError ? message : undefined };
}
