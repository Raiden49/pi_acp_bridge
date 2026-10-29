import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";
import type { ClientFileSystem } from "./client-filesystem.js";
import type { SessionLease } from "./session-lease.js";
import type { Questions } from "./questions.js";

export interface ActivePrompt {
  cancelled: boolean;
  command: boolean;
  acceptingInputs: boolean;
  inputs: Set<Promise<void>>;
  inputError?: unknown;
  flush?: () => Promise<void>;
  unsubscribe: () => void;
  notify?: (text: string) => void;
  update?: (update: SessionUpdate) => Promise<void>;
  settled: Promise<void>;
}
export interface ManagedSession {
  session: BridgeSession;
  cwd: string;
  active?: ActivePrompt;
  waitingPrompt?: AbortController;
  changingConfiguration?: Promise<void>;
  notices?: string[];
  questions?: Questions;
  unsubscribeMetadata?: () => void;
  lastWarning?: string;
  configurationSignature?: string;
  fileSystem?: ClientFileSystem;
  lease?: SessionLease;
}

export interface SessionHost {
  sessions: Map<string, ManagedSession>;
  deleting: Set<string>;
  forking: Set<string>;
  getSession(id: string): ManagedSession;
  isClosed(): boolean;
  sendUpdate: AgentSideConnection["sessionUpdate"];
  trace(event: Record<string, string | number | boolean>): void;
  indexSession(id: string, entry: ManagedSession): Promise<void>;
}
