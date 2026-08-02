/**
 * The running / startup configuration lifecycle, as a network engineer types it.
 *
 * These commands own no configuration logic at all: every one of them delegates
 * to the `DeviceConfigurationService` the runtime injected, which renders and
 * stores structured state through `lab-format`. What lives here is the IOS
 * grammar, the prompts and the confirmation flow.
 */
import { ValidationError } from "../errors/errors";
import type { CliMode } from "../session/mode";
import type { CommandSpec, SessionApi } from "../types";
import type { DeviceConfigurationService } from "../session/configuration";

const SHOW_MODES: CliMode[] = ["exec", "privileged"];
const PRIVILEGED: CliMode[] = ["privileged"];

/** Every device that keeps a configuration file has a management CLI. */
const CONFIGURATION_DEVICE = "network" as const;

function service(session: SessionApi): DeviceConfigurationService {
  const configuration = session.configurationService();
  if (!configuration) {
    throw new ValidationError("The configuration service is not available in this runtime.");
  }
  return configuration;
}

/** IOS prints the build banner before the file, and so do we. */
const SAVE_OUTPUT = [
  "Destination filename [startup-config]?",
  "Building configuration...",
  "[OK]",
].join("\n");

const WRITE_OUTPUT = ["Building configuration...", "[OK]"].join("\n");

const ERASE_PROMPT = "Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]";
const RELOAD_PROMPT = "Proceed with reload? [confirm]";
const MODIFIED_PROMPT = "System configuration has been modified. Save? [yes/no]:";

function reload(session: SessionApi, save: boolean): string {
  service(session).reloadDevice(session.device.id, { save });
  return [
    save ? "Building configuration...\n[OK]" : "",
    "Reload requested.",
    `${session.device.name} is reloading. Runtime state on this device has been cleared;`,
    "other devices keep running.",
  ].filter((line) => line.length > 0).join("\n");
}

/**
 * `reload` with the IOS three-way answer: yes saves first, no discards the
 * unsaved running configuration, and anything else cancels the reload.
 */
function confirmReload(session: SessionApi): string {
  const drift = service(session).drift(session.device.id);
  if (drift === "saved") {
    return session.requestConfirmation(RELOAD_PROMPT, () => reload(session, false));
  }
  return session.requestAnswer(MODIFIED_PROMPT, (line) => {
    const answer = line.trim().toLowerCase();
    if (answer === "yes" || answer === "y") {
      return session.requestConfirmation(RELOAD_PROMPT, () => reload(session, true));
    }
    if (answer === "no" || answer === "n") {
      return session.requestConfirmation(RELOAD_PROMPT, () => reload(session, false));
    }
    return "% Reload cancelled.";
  });
}

export const configurationCommands: CommandSpec[] = [
  {
    pattern: "show running-config",
    modes: SHOW_MODES,
    device: CONFIGURATION_DEVICE,
    // A configuration file ends with a newline; a terminal transcript does not.
    run: (s) => service(s).runningConfigurationText(s.device.id).trimEnd(),
  },
  {
    pattern: "show startup-config",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    run: (s) => service(s).startupConfigurationText(s.device.id).trimEnd(),
  },
  {
    // `copy run start` reaches this through the matcher's literal-prefix rule.
    pattern: "copy running-config startup-config",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    usage: "copy running-config startup-config",
    run: (s) => {
      service(s).saveRunningConfiguration(s.device.id);
      return SAVE_OUTPUT;
    },
  },
  {
    pattern: "write memory",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    run: (s) => {
      service(s).saveRunningConfiguration(s.device.id);
      return WRITE_OUTPUT;
    },
  },
  {
    // Bare `write` — and therefore `wr` — is the same operation, as on IOS.
    pattern: "write",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    run: (s) => {
      service(s).saveRunningConfiguration(s.device.id);
      return WRITE_OUTPUT;
    },
  },
  {
    pattern: "erase startup-config",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    run: (s) => s.requestConfirmation(ERASE_PROMPT, () => {
      service(s).eraseStartupConfiguration(s.device.id);
      return "[OK]\nErase of nvram: complete";
    }),
  },
  {
    pattern: "reload",
    modes: PRIVILEGED,
    device: CONFIGURATION_DEVICE,
    run: (s) => confirmReload(s),
  },
];
