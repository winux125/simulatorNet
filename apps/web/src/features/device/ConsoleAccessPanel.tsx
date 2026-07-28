import {
  MAX_CONSOLE_USERS,
  type ConsoleAccessConfiguration,
  type ConsoleAuthenticationMode,
  type LabDocument,
} from "@sim/contracts";
import {
  createPasswordVerifier,
  emptyConsoleAccess,
  managementCredentialFingerprint,
  managementCredentialScope,
} from "@sim/console-auth";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import type { LabUiNode } from "@sim/sim-worker";
import { Button, IconButton } from "../../ui";
import { consoleAccessOf, withConsoleAccess } from "../lab/document";

interface ConsoleAccessPanelProps {
  document: LabDocument;
  node: LabUiNode;
  onConfigurationChanged(document: LabDocument, runtimeSynchronized: boolean): void;
  onError(message: string): void;
}

const MODE_LABELS: Record<ConsoleAuthenticationMode, string> = {
  none: "None",
  "press-return": "Press RETURN",
  "password-only": "Password",
  "local-user": "Local User",
};

/**
 * Config → Console Access. Edits the draft device configuration only. New
 * passwords are hashed into verifiers before they touch the document; an
 * existing password/hash is never shown — only "Password configured" + Reset.
 * This is simulated device auth, separate from the SimulatorNet account login.
 */
export function ConsoleAccessPanel({ document, node, onConfigurationChanged, onError }: ConsoleAccessPanelProps) {
  const access = consoleAccessOf(document, node.id) ?? emptyConsoleAccess();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [privilege, setPrivilege] = useState(1);
  const [linePassword, setLinePassword] = useState("");
  const [enableSecret, setEnableSecret] = useState("");

  const update = (next: ConsoleAccessConfiguration) => onConfigurationChanged(withConsoleAccess(document, node.id, next), false);

  const guard = async (run: () => Promise<void>) => {
    setBusy(true);
    try { await run(); } catch (error) { onError(error instanceof Error ? error.message : "Could not update console access"); } finally { setBusy(false); }
  };

  const addUser = () => guard(async () => {
    if (!username.trim() || !userPassword) { onError("Username and password are required"); return; }
    if (access.users.length >= MAX_CONSOLE_USERS) { onError(`A device may have at most ${MAX_CONSOLE_USERS} console users`); return; }
    const name = username.trim();
    const verifier = await createPasswordVerifier(userPassword);
    // The same user also authenticates over the management plane, which needs a
    // value the deterministic engine can compare. Both forms are derived here,
    // before any packet processing, and the password itself is discarded.
    const fingerprint = await managementCredentialFingerprint(
      managementCredentialScope.user(name),
      userPassword,
    );
    update({
      ...access,
      mode: access.mode === "none" ? "local-user" : access.mode,
      users: [
        ...access.users.filter((user) => user.username !== name),
        {
          id: `user-${Date.now()}`,
          username: name,
          passwordVerifier: verifier,
          credentialFingerprint: fingerprint,
          privilegeLevel: Math.min(15, Math.max(0, privilege)),
          enabled: true,
        },
      ],
    });
    setUsername(""); setUserPassword(""); setPrivilege(1);
  });

  const setLine = () => guard(async () => {
    if (!linePassword) { onError("Enter a console password"); return; }
    update({ ...access, mode: access.mode === "local-user" ? access.mode : "password-only", consolePasswordVerifier: await createPasswordVerifier(linePassword) });
    setLinePassword("");
  });

  const setEnable = () => guard(async () => {
    if (!enableSecret) { onError("Enter an enable secret"); return; }
    update({
      ...access,
      enableSecretVerifier: await createPasswordVerifier(enableSecret),
      // Remote `enable` compares this opaque form inside the engine.
      enableCredentialFingerprint: await managementCredentialFingerprint(
        managementCredentialScope.enable(),
        enableSecret,
      ),
      credentialResetRequired: false,
    });
    setEnableSecret("");
  });

  return (
    <div className="device-window-section console-access" data-testid="console-access-panel">
      <p className="section-eyebrow">Config · Console Access</p>
      <p className="section-note">Simulated login for this device. These credentials are separate from your SimulatorNet account and are never stored in the clear.</p>

      {access.credentialResetRequired && (
        <p className="console-access__warning" role="status">An imported vendor password could not be verified. Set a new simulated password below.</p>
      )}

      <label className="field">Authentication
        <select data-testid="console-mode" value={access.mode} disabled={busy} onChange={(event) => update({ ...access, mode: event.target.value as ConsoleAuthenticationMode })}>
          {(Object.keys(MODE_LABELS) as ConsoleAuthenticationMode[]).map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
        </select>
      </label>

      {access.mode === "password-only" && (
        <fieldset className="console-access__group">
          <legend>Console password {access.consolePasswordVerifier ? "· configured" : ""}</legend>
          <div className="field-row">
            <input type="password" aria-label="Console password" placeholder={access.consolePasswordVerifier ? "Reset password" : "Set password"} value={linePassword} onChange={(event) => setLinePassword(event.target.value)} />
            <Button type="button" variant="primary" disabled={busy} onClick={setLine}>{access.consolePasswordVerifier ? "Reset" : "Set"}</Button>
          </div>
        </fieldset>
      )}

      {access.mode === "local-user" && (
        <fieldset className="console-access__group">
          <legend>Local users</legend>
          <ul className="console-access__users" data-testid="console-users">
            {access.users.map((user) => (
              <li key={user.id}>
                <KeyRound size={13} aria-hidden="true" />
                <span>{user.username}</span>
                <small>privilege {user.privilegeLevel} · Password configured</small>
                <IconButton label={`Remove ${user.username}`} icon={<Trash2 size={13} />} onClick={() => update({ ...access, users: access.users.filter((candidate) => candidate.id !== user.id) })} />
              </li>
            ))}
            {access.users.length === 0 && <li className="is-empty">No console users yet.</li>}
          </ul>
          <div className="field-row">
            <input aria-label="New username" placeholder="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            <input type="password" aria-label="New user password" placeholder="password" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} />
            <input type="number" aria-label="Privilege level" min={0} max={15} value={privilege} onChange={(event) => setPrivilege(Number(event.target.value))} />
            <Button type="button" variant="primary" disabled={busy} onClick={addUser}>Add user</Button>
          </div>
        </fieldset>
      )}

      <fieldset className="console-access__group">
        <legend>Enable secret {access.enableSecretVerifier ? "· configured" : ""}</legend>
        <div className="field-row">
          <input type="password" aria-label="Enable secret" placeholder={access.enableSecretVerifier ? "Reset enable secret" : "Set enable secret"} value={enableSecret} onChange={(event) => setEnableSecret(event.target.value)} />
          <Button type="button" variant="primary" disabled={busy} onClick={setEnable}>{access.enableSecretVerifier ? "Reset" : "Set"}</Button>
          {access.enableSecretVerifier && <Button type="button" disabled={busy} onClick={() => update({ ...access, enableSecretVerifier: undefined })}>Clear</Button>}
        </div>
      </fieldset>

      <label className="field">Login banner
        <textarea aria-label="Login banner" rows={2} value={access.loginBanner ?? ""} onChange={(event) => update({ ...access, loginBanner: event.target.value || undefined })} />
      </label>
      <label className="field">MOTD banner
        <textarea aria-label="MOTD banner" rows={2} value={access.motdBanner ?? ""} onChange={(event) => update({ ...access, motdBanner: event.target.value || undefined })} />
      </label>
      <label className="field">Maximum attempts
        <input type="number" aria-label="Maximum attempts" min={1} max={10} value={access.maximumAttempts} onChange={(event) => update({ ...access, maximumAttempts: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })} />
      </label>
    </div>
  );
}

export default ConsoleAccessPanel;
