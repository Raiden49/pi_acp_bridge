import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import type { BridgeSession } from "./sessions.js";

export function modelConfigOptions(session: BridgeSession): SessionConfigOption[] {
  if (!session.model || !session.modelRuntime || !session.setModel) return [];
  const models = new Map(session.modelRuntime.getModels().map((model) => [`${model.provider}/${model.id}`, model]));
  const currentValue = `${session.model.provider}/${session.model.id}`;
  models.set(currentValue, session.model);
  return [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: [...models].map(([value, model]) => ({ value, name: `${model.name} (${model.provider})` })),
  }];
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
