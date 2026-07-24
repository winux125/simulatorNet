// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsoleAccessConfiguration, LabDocument, RouterDeviceConfig } from "@sim/contracts";
import { verifyPassword } from "@sim/console-auth";
import { ConsoleAccessPanel } from "./ConsoleAccessPanel";

const node = { id: "r1", type: "router", hostname: "R1", status: "down", interfaces: [] } as never;

function routerDoc(consoleAccess?: ConsoleAccessConfiguration): LabDocument {
  return {
    schemaVersion: 1, id: "lab", title: "Lab", simulation: { seed: 1 },
    topology: { schemaVersion: 1, nodes: [{ id: "r1", kind: "router", interfaces: [] }], links: [] },
    configurations: {
      r1: { kind: "router", hostname: "R1", interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [], consoleAccess },
    },
  };
}
const accessOf = (document: LabDocument): ConsoleAccessConfiguration | undefined =>
  (document.configurations.r1 as RouterDeviceConfig).consoleAccess;

afterEach(cleanup);

describe("ConsoleAccessPanel", () => {
  it("switches authentication mode on the draft document", () => {
    const onChange = vi.fn();
    render(<ConsoleAccessPanel document={routerDoc()} node={node} onConfigurationChanged={onChange} onError={() => undefined} />);
    fireEvent.change(screen.getByTestId("console-mode"), { target: { value: "local-user" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(accessOf(onChange.mock.calls[0]![0] as LabDocument)?.mode).toBe("local-user");
  });

  it("adds a local user as a verifier and never renders the hash", async () => {
    const onChange = vi.fn();
    const initial: ConsoleAccessConfiguration = { mode: "local-user", users: [], maximumAttempts: 3, credentialResetRequired: false };
    render(<ConsoleAccessPanel document={routerDoc(initial)} node={node} onConfigurationChanged={onChange} onError={() => undefined} />);
    fireEvent.change(screen.getByLabelText("New username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("New user password"), { target: { value: "cisco123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    const access = accessOf(onChange.mock.calls.at(-1)![0] as LabDocument)!;
    expect(access.users[0]?.username).toBe("admin");
    expect(access.users[0]?.passwordVerifier.algorithm).toBe("pbkdf2-sha256");
    expect(await verifyPassword("cisco123", access.users[0]!.passwordVerifier)).toBe(true);
    // The rendered panel never contains the plaintext or the hash.
    expect(document.body.textContent).not.toContain("cisco123");
    expect(document.body.textContent).not.toContain(access.users[0]!.passwordVerifier.hashBase64);
  });
});
