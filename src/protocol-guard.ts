import { RequestError, type Agent } from "@agentclientprotocol/sdk";

// The SDK validates wire shapes; connection lifecycle ordering belongs to us.
export function guardInitialization(agent: Agent): Agent {
  let state: "new" | "initializing" | "ready" = "new";
  return new Proxy(agent, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        if (property !== "initialize") {
          if (state !== "ready") throw new RequestError(-32600, "Connection is not initialized");
          return method.apply(target, args);
        }
        if (state !== "new") throw new RequestError(-32600, "Connection is already initialized or initializing");
        state = "initializing";
        try {
          const result = await method.apply(target, args);
          state = "ready";
          return result;
        } catch (error) {
          state = "new";
          throw error;
        }
      };
    },
  });
}
