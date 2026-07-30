import { beforeEach, describe, expect, it } from "vitest";
import type { ConsoleAccessConfiguration } from "@sim/contracts";
import { ConsoleAuthSession, createPasswordVerifier, emptyConsoleAccess, renderConsoleAccessConfig } from "@sim/console-auth";

const ITER = 1_500;
let commands: string[];
let privileged: boolean | undefined;
const hooks = {
  execute: (line: string): string => { commands.push(line); return `ran:${line}`; },
  setPrivileged: (value: boolean): void => { privileged = value; },
};

beforeEach(() => { commands = []; privileged = undefined; });

async function passwordOnly(): Promise<ConsoleAccessConfiguration> {
  return { mode: "password-only", users: [], consolePasswordVerifier: await createPasswordVerifier("linepass", ITER), maximumAttempts: 2, credentialResetRequired: false };
}
async function localUser(privilegeLevel = 1, enableSecret = false): Promise<ConsoleAccessConfiguration> {
  return {
    mode: "local-user",
    users: [{ id: "u1", username: "admin", passwordVerifier: await createPasswordVerifier("cisco123", ITER), privilegeLevel, enabled: true }],
    enableSecretVerifier: enableSecret ? await createPasswordVerifier("enablepass", ITER) : undefined,
    maximumAttempts: 2,
    credentialResetRequired: false,
  };
}

describe("console login session", () => {
  it("opens straight to the prompt when auth is disabled", async () => {
    const session = new ConsoleAuthSession(emptyConsoleAccess(), hooks);
    expect(session.begin().state).toBe("authenticated-user-exec");
    expect(session.isAuthenticated()).toBe(true);
    expect((await session.submit("show version")).output).toBe("ran:show version");
  });

  it("gates on Press RETURN", async () => {
    const session = new ConsoleAuthSession({ ...emptyConsoleAccess(), mode: "press-return" }, hooks);
    const start = session.begin();
    expect(start.state).toBe("awaiting-return");
    expect(start.output).toBe("");
    expect(start.prompt).toMatchObject({
      text: "Press RETURN to get started!",
      echo: "plain",
      history: false,
    });
    expect(commands).toHaveLength(0);
    expect((await session.submit("")).state).toBe("authenticated-user-exec");
  });

  it("accepts a correct console password without echoing it, and rejects a wrong one", async () => {
    const session = new ConsoleAuthSession(await passwordOnly(), hooks);
    session.begin();
    expect(session.expectsSecret()).toBe(true);
    const bad = await session.submit("nope");
    expect(bad.secret).toBe(true);
    expect(bad.output).not.toContain("nope");
    expect(bad.output).toContain("% Login invalid");
    expect(session.isAuthenticated()).toBe(false);
    const good = await session.submit("linepass");
    expect(good.output).not.toContain("linepass");
    expect(session.isAuthenticated()).toBe(true);
  });

  it("logs in a local user and forwards commands only after authentication", async () => {
    const session = new ConsoleAuthSession(await localUser(), hooks);
    expect(session.begin().prompt?.text).toBe("Username: ");
    expect((await session.submit("admin")).prompt?.text).toBe("Password: ");
    expect(session.expectsSecret()).toBe(true);
    expect(commands).toHaveLength(0);
    const result = await session.submit("cisco123");
    expect(result.authenticated).toBe(true);
    expect(privileged).toBe(false); // privilege 1 -> user exec ">"
    expect((await session.submit("show ip route")).output).toBe("ran:show ip route");
  });

  it("rejects an unknown username", async () => {
    const session = new ConsoleAuthSession(await localUser(), hooks);
    session.begin();
    await session.submit("ghost");
    const result = await session.submit("whatever");
    expect(result.output).toContain("% Login invalid");
    expect(session.isAuthenticated()).toBe(false);
  });

  it("gives up after the maximum number of attempts", async () => {
    const session = new ConsoleAuthSession(await passwordOnly(), hooks);
    session.begin();
    await session.submit("wrong1");
    const final = await session.submit("wrong2");
    expect(final.output).toContain("% Authentication failed");
    expect(session.state).toBe("awaiting-password"); // restarted
    expect(session.isAuthenticated()).toBe(false);
  });

  it("puts a privilege-15 user straight into privileged exec", async () => {
    const session = new ConsoleAuthSession(await localUser(15), hooks);
    session.begin();
    await session.submit("admin");
    const result = await session.submit("cisco123");
    expect(result.state).toBe("privileged-exec");
    expect(privileged).toBe(true);
  });

  it("gates enable behind the enable secret", async () => {
    const session = new ConsoleAuthSession(await localUser(1, true), hooks);
    session.begin();
    await session.submit("admin");
    await session.submit("cisco123");
    expect((await session.submit("enable")).prompt).toMatchObject({
      text: "Password: ",
      echo: "hidden",
      history: false,
    });
    expect(session.expectsSecret()).toBe(true);
    const denied = await session.submit("badenable");
    expect(denied.output).toContain("% Access denied");
    expect(session.state).toBe("authenticated-user-exec");
    await session.submit("enable");
    const ok = await session.submit("enablepass");
    expect(ok.state).toBe("privileged-exec");
    expect(privileged).toBe(true);
  });

  it("keeps sessions isolated and re-requires login after restart", async () => {
    const config = await localUser();
    const a = new ConsoleAuthSession(config, hooks);
    const b = new ConsoleAuthSession(config, hooks);
    a.begin();
    await a.submit("admin");
    await a.submit("cisco123");
    expect(a.isAuthenticated()).toBe(true);
    expect(b.isAuthenticated()).toBe(false); // independent
    a.begin(); // restart (stop/start) requires login again, verifier preserved
    expect(a.isAuthenticated()).toBe(false);
    await a.submit("admin");
    expect((await a.submit("cisco123")).authenticated).toBe(true);
  });

  it("renders a redacted running-config that never leaks the hash", async () => {
    const config = await localUser(15, true);
    const lines = renderConsoleAccessConfig(config).join("\n");
    expect(lines).toContain("username admin privilege 15 secret 5 <hidden>");
    expect(lines).toContain("enable secret 5 <hidden>");
    expect(lines).toContain("login local");
    expect(lines).not.toContain(config.users[0]!.passwordVerifier.hashBase64);
  });

  it("keeps authentication prompts separate from output with explicit echo policies", async () => {
    const session = new ConsoleAuthSession(await localUser(1, true), hooks);
    const username = session.begin();
    expect(username.output).toBe("");
    expect(username.prompt).toEqual({
      text: "Username: ",
      echo: "plain",
      history: false,
      completion: "line",
    });

    const password = await session.submit("admin");
    expect(password.output).toBe("");
    expect(password.prompt).toEqual({
      text: "Password: ",
      echo: "hidden",
      history: false,
      completion: "line",
    });
  });

  it("formats login banners and retries without leading or duplicate blank lines", async () => {
    const session = new ConsoleAuthSession({
      ...await localUser(),
      motdBanner: "SimulatorNet lab",
      loginBanner: "Authorized access only.",
    }, hooks);
    const begin = session.begin();
    expect(begin.output).toBe("Authorized access only.\n");
    expect(begin.prompt?.text).toBe("Username: ");

    await session.submit("admin");
    const failure = await session.submit("wrong-password");
    expect(failure.output).toBe("% Login invalid\n\n");
    expect(failure.prompt?.text).toBe("Username: ");

    await session.submit("admin");
    const success = await session.submit("cisco123");
    expect(success.output).toBe("SimulatorNet lab\n");
    expect(success.prompt).toBeUndefined();
  });

  it("clears failed credentials and never returns plaintext passwords", async () => {
    const session = new ConsoleAuthSession(await localUser(), hooks);
    session.begin();
    await session.submit("admin");
    const failure = await session.submit("do-not-leak");
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("admin");
    expect(failure.state).toBe("awaiting-username");
  });
});
