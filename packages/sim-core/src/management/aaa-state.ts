import {
  AAA_LIMITS,
  DEFAULT_AAA_CONFIGURATION,
  type AaaAccountingList,
  type AaaCommandMethodList,
  type AaaConfiguration,
  type AaaMethod,
  type AaaMethodList,
  type AaaServerConfig,
} from "@sim/contracts";

/**
 * Persistent AAA configuration of one managed device.
 *
 * Like `RemoteAccessState`, this holds structured configuration only; the
 * decision layer that walks a method list and talks to RADIUS/TACACS+ lives in
 * `@sim/remote-management`. Keeping it here lets `lab-format` serialize AAA the
 * same way it serializes ACLs, NAT and spanning tree.
 */
export class AaaState {
  private config: AaaConfiguration = { ...DEFAULT_AAA_CONFIGURATION };
  private changeListener: (() => void) | undefined;

  onChanged(listener: () => void): void {
    this.changeListener = listener;
  }

  configure(config: AaaConfiguration | undefined): void {
    this.config = normalizeAaaConfiguration(config ?? DEFAULT_AAA_CONFIGURATION);
    this.changed();
  }

  snapshot(): AaaConfiguration {
    return cloneAaaConfiguration(this.config);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get servers(): readonly AaaServerConfig[] {
    return this.config.servers;
  }

  /** `aaa new-model`. Turning it off returns the device to local-only login. */
  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled };
    this.changed();
  }

  /**
   * The list a caller should use: the named list when it exists, otherwise
   * `default`. Returns undefined when AAA is off or nothing is configured, so
   * the caller falls back to the plain local/line behaviour.
   */
  authenticationList(name: string | undefined): AaaMethodList | undefined {
    return this.config.enabled ? selectList(this.config.authenticationLogin, name) : undefined;
  }

  authorizationExecList(name: string | undefined): AaaMethodList | undefined {
    return this.config.enabled ? selectList(this.config.authorizationExec, name) : undefined;
  }

  authorizationCommandList(privilegeLevel: number, name?: string): AaaCommandMethodList | undefined {
    if (!this.config.enabled) return undefined;
    const candidates = this.config.authorizationCommands.filter(
      (list) => list.privilegeLevel === privilegeLevel,
    );
    return selectList(candidates, name);
  }

  accountingExecList(name?: string): AaaAccountingList | undefined {
    return this.config.enabled ? selectList(this.config.accountingExec, name) : undefined;
  }

  accountingCommandList(privilegeLevel: number, name?: string): AaaAccountingList | undefined {
    if (!this.config.enabled) return undefined;
    const candidates = this.config.accountingCommands.filter(
      (list) => list.privilegeLevel === undefined || list.privilegeLevel === privilegeLevel,
    );
    return selectList(candidates, name);
  }

  serversFor(method: AaaMethod): AaaServerConfig[] {
    if (method === "group radius") return this.config.servers.filter((server) => server.protocol === "radius");
    if (method === "group tacacs+") return this.config.servers.filter((server) => server.protocol === "tacacs+");
    return [];
  }

  setAuthenticationLogin(list: AaaMethodList): void {
    this.config = { ...this.config, authenticationLogin: upsertList(this.config.authenticationLogin, list) };
    this.changed();
  }

  setAuthorizationExec(list: AaaMethodList): void {
    this.config = { ...this.config, authorizationExec: upsertList(this.config.authorizationExec, list) };
    this.changed();
  }

  setAuthorizationCommands(list: AaaCommandMethodList): void {
    const others = this.config.authorizationCommands.filter(
      (entry) => !(entry.name === list.name && entry.privilegeLevel === list.privilegeLevel),
    );
    this.config = { ...this.config, authorizationCommands: sortLists([...others, list]) };
    this.changed();
  }

  setAccountingExec(list: AaaAccountingList): void {
    this.config = { ...this.config, accountingExec: upsertList(this.config.accountingExec, list) };
    this.changed();
  }

  setAccountingCommands(list: AaaAccountingList): void {
    const others = this.config.accountingCommands.filter(
      (entry) => !(entry.name === list.name && entry.privilegeLevel === list.privilegeLevel),
    );
    this.config = { ...this.config, accountingCommands: sortLists([...others, list]) };
    this.changed();
  }

  defineServer(server: AaaServerConfig): void {
    const others = this.config.servers.filter((entry) => entry.name !== server.name);
    if (others.length >= AAA_LIMITS.maximumServersPerDevice) {
      throw new Error(`AAA server limit exceeded (${AAA_LIMITS.maximumServersPerDevice})`);
    }
    this.config = {
      ...this.config,
      servers: [...others, server].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.name.localeCompare(b.name)),
    };
    this.changed();
  }

  removeServer(name: string): boolean {
    const remaining = this.config.servers.filter((server) => server.name !== name);
    if (remaining.length === this.config.servers.length) return false;
    this.config = { ...this.config, servers: remaining };
    this.changed();
    return true;
  }

  serverByName(name: string): AaaServerConfig | undefined {
    return this.config.servers.find((server) => server.name === name);
  }

  private changed(): void {
    this.changeListener?.();
  }
}

function selectList<T extends { name: string }>(lists: readonly T[], name: string | undefined): T | undefined {
  if (name) {
    const named = lists.find((list) => list.name === name);
    if (named) return named;
  }
  return lists.find((list) => list.name === "default");
}

function upsertList<T extends { name: string }>(lists: readonly T[], list: T): T[] {
  return sortLists([...lists.filter((entry) => entry.name !== list.name), list]);
}

/** `default` first, then named lists alphabetically: observable, stable order. */
function sortLists<T extends { name: string; privilegeLevel?: number }>(lists: readonly T[]): T[] {
  return [...lists].sort((a, b) => {
    if (a.name !== b.name) {
      if (a.name === "default") return -1;
      if (b.name === "default") return 1;
      return a.name.localeCompare(b.name);
    }
    return (a.privilegeLevel ?? -1) - (b.privilegeLevel ?? -1);
  });
}

export function normalizeAaaConfiguration(config: AaaConfiguration): AaaConfiguration {
  return {
    enabled: config.enabled,
    authenticationLogin: sortLists(config.authenticationLogin).map(cloneList),
    authorizationExec: sortLists(config.authorizationExec).map(cloneList),
    authorizationCommands: sortLists(config.authorizationCommands).map(cloneList),
    accountingExec: sortLists(config.accountingExec).map(cloneList),
    accountingCommands: sortLists(config.accountingCommands).map(cloneList),
    servers: [...config.servers]
      .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.name.localeCompare(b.name))
      .map((server) => ({ ...server })),
  };
}

function cloneList<T extends { methods: readonly AaaMethod[] }>(list: T): T {
  return { ...list, methods: [...list.methods] };
}

function cloneAaaConfiguration(config: AaaConfiguration): AaaConfiguration {
  return normalizeAaaConfiguration(config);
}

/** True when AAA has not been configured at all, so it serializes as absent. */
export function isDefaultAaaConfiguration(config: AaaConfiguration | undefined): boolean {
  if (!config) return true;
  return !config.enabled
    && config.authenticationLogin.length === 0
    && config.authorizationExec.length === 0
    && config.authorizationCommands.length === 0
    && config.accountingExec.length === 0
    && config.accountingCommands.length === 0
    && config.servers.length === 0;
}
