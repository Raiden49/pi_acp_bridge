import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export function modelConfigOptions(session: BridgeSession): SessionConfigOption[] {
  if (!session.model || !session.modelRuntime || !session.setModel) return [];
  const models = session.modelRuntime.getAvailableSnapshot();
  const currentValue = `${session.model.provider}/${session.model.id}`;
  if (!models.some((model) => `${model.provider}/${model.id}` === currentValue)) return [];
  const options: SessionConfigOption[] = [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: models.map((model) => ({ value: `${model.provider}/${model.id}`, name: `${model.name} (${model.provider})` })),
  }];
  if (session.model.reasoning && session.setThinkingLevel && session.getAvailableThinkingLevels && session.thinkingLevel) {
    options.push({ id: "thinking", name: "Thinking", category: "thought_level", type: "select",
      currentValue: session.thinkingLevel,
      options: session.getAvailableThinkingLevels().map((level) => ({ value: level, name: level })),
    });
  }
  return options;
}

export interface AdvertisedModel {
  modelId: string;
  name: string;
}

export async function discoverModels(modelsPath?: string): Promise<AdvertisedModel[]> {
  // Discovery must not refresh remote catalogs, resolve secrets, or write credentials.
  const runtime = await ModelRuntime.create({
    modelsPath,
    credentials: {
      async read() { return undefined; },
      async list() { return []; },
      async modify() { throw new Error("Model discovery is read-only"); },
      async delete() { throw new Error("Model discovery is read-only"); },
    },
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  if (runtime.getError()) {
    // Pi validation errors can include configuration contents; never forward them.
    throw new RequestError(-32603, "Invalid Pi model configuration");
  }
  return runtime.getModels().map((model) => ({
    modelId: `${model.provider}/${model.id}`,
    name: model.name,
  }));
}
