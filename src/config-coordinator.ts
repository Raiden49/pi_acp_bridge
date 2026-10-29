import { RequestError, type SessionUpdate, type SetSessionModeRequest, type SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { sessionConfiguration } from "./models.js";
import { isLiveConfiguration, setLegacyMode, setSessionOption } from "./session-options.js";
import { bridgeError } from "./errors.js";
import type { BridgeSession } from "./sessions.js";
import type { ManagedSession, SessionHost } from "./managed-session.js";

export function createConfigCoordinator({
  sessions, deleting, forking, getSession, isClosed, sendUpdate, trace, indexSession,
}: SessionHost) {
  function usageUpdate(session: BridgeSession, estimatedTokens?: number): SessionUpdate | undefined {
    const usage = session.getContextUsage();
    // Compaction supplies a temporary estimate until post-compaction model usage is available.
    const tokens = usage?.tokens ?? estimatedTokens;
    if (!usage || tokens == null) return;
    return { sessionUpdate: "usage_update", used: tokens, size: usage.contextWindow };
  }
  async function publishUsage(sessionId: string, session: BridgeSession) {
    const update = usageUpdate(session);
    if (update && !isClosed()) await sendUpdate({ sessionId, update });
  }
  async function warnConfiguration(sessionId: string, entry: ManagedSession, warning?: string) {
    if (warning === entry.lastWarning) return;
    entry.lastWarning = warning;
    if (warning && !isClosed()) await sendUpdate({ sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${warning}\n` },
    } });
  }
  async function publishConfiguration(sessionId: string, session: BridgeSession,
    configuration?: Awaited<ReturnType<typeof sessionConfiguration>>, settled = false) {
    const state = configuration ?? await sessionConfiguration(session);
    const { configOptions, modes, warning } = state;
    const entry = sessions.get(sessionId);
    if (!isClosed() && entry?.session === session && (!entry.active?.cancelled || settled)) {
      if (!entry.active?.cancelled) await warnConfiguration(sessionId, entry, warning);
      if (modes) await sendUpdate({ sessionId, update: {
        sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId,
      } });
      await sendUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions } });
      entry.configurationSignature = JSON.stringify(state);
    }
    return configOptions;
  }
  function serializeConfiguration<T>(entry: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const pending = (entry.changingConfiguration ?? Promise.resolve()).then(operation);
    const tail = pending.then(() => {}, () => {});
    entry.changingConfiguration = tail;
    void tail.then(() => {
      if (entry.changingConfiguration === tail) entry.changingConfiguration = undefined;
    });
    return pending;
  }
  function syncConfiguration(sessionId: string, entry: ManagedSession, { force = false, settled = false } = {}) {
    return serializeConfiguration(entry, async () => {
      if (isClosed() || sessions.get(sessionId) !== entry || deleting.has(sessionId)) return false;
      // Compute inside the same queue as setters, never publish a pre-mutation snapshot later.
      const state = await sessionConfiguration(entry.session);
      if (!force && JSON.stringify(state) === entry.configurationSignature) return false;
      await publishConfiguration(sessionId, entry.session, state, settled);
      return true;
    });
  }
  async function changeConfiguration(sessionId: string, configId: string, change: (session: BridgeSession) => void | Promise<void>, live = false) {
    const option = ["model", "thinking", "mode", "approval"].includes(configId) ? configId : "unsupported";
    const report = (stage: string, fields: Record<string, string | number | boolean> = {}) =>
      trace({ event: "configuration_change", sessionId, configId: option, stage, ...fields });
    report("received");
    const entry = getSession(sessionId);
    if (entry.changingConfiguration) report("queued");
    return serializeConfiguration(entry, async () => {
      try {
        if (isClosed() || sessions.get(sessionId) !== entry || deleting.has(sessionId) || forking.has(sessionId)) {
          throw new RequestError(-32600, "Session is closing or unavailable");
        }
        if (entry.active && (!live || entry.active.command || entry.active.cancelled)) {
          throw new RequestError(-32600, "Session is busy");
        }
        report("applying");
        await change(entry.session);
        if (entry.session.bridgeApproval) await indexSession(sessionId, entry);
        const configOptions = await publishConfiguration(sessionId, entry.session);
        if (sessions.get(sessionId) === entry && !deleting.has(sessionId)) await publishUsage(sessionId, entry.session);
        report("applied", { model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : "none",
          thinking: entry.session.thinkingLevel ?? "off" });
        return configOptions;
      } catch (error) {
        report("failed", { code: error instanceof RequestError ? error.code : -32603 });
        // Correct optimistic clients even when the selection itself never changed.
        if (!isClosed() && sessions.get(sessionId) === entry && !deleting.has(sessionId)) {
          await publishConfiguration(sessionId, entry.session, undefined, true).catch(() => report("reconciliation_failed"));
        }
        throw bridgeError("Unable to update Pi session configuration", error);
      }
    });
  }

  return {
    usageUpdate, publishUsage, warnConfiguration, syncConfiguration,
    async setSessionMode({ sessionId, modeId }: SetSessionModeRequest) {
      await changeConfiguration(sessionId, "mode", session => setLegacyMode(session, modeId), isLiveConfiguration("mode", modeId));
      return {};
    },
    async setSessionConfigOption({ sessionId, configId, value }: SetSessionConfigOptionRequest) {
      const configOptions = await changeConfiguration(sessionId, configId,
        session => setSessionOption(session, configId, value), isLiveConfiguration(configId, value));
      return { configOptions };
    },
  };
}

export type ConfigCoordinator = ReturnType<typeof createConfigCoordinator>;
