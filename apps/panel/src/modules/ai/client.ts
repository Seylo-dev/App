// The Anthropic client the assistant uses, behind a small interface so
// tests can script replies without the network. The real one is the
// official SDK (@anthropic-ai/sdk, pinned).

import Anthropic from "@anthropic-ai/sdk";

export type StreamParams = Anthropic.MessageStreamParams;
export type StreamEvent = Anthropic.MessageStreamEvent;

export interface ModelStream extends AsyncIterable<StreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

export interface ModelClient {
  stream(params: StreamParams, options: { signal: AbortSignal }): ModelStream;
}

export interface ModelProvider {
  client(apiKey: string): ModelClient;
  /** Throws KeyCheckError when Anthropic refuses the key. */
  checkKey(apiKey: string): Promise<void>;
}

export class KeyCheckError extends Error {
  override name = "KeyCheckError";
  constructor(
    message: string,
    readonly refused: boolean,
  ) {
    super(message);
  }
}

const anthropicProvider: ModelProvider = {
  client(apiKey) {
    const sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
    return { stream: (params, options) => sdk.messages.stream(params, { signal: options.signal }) };
  },
  async checkKey(apiKey) {
    const sdk = new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 });
    try {
      // Free: reads one model's metadata.
      await sdk.models.retrieve("claude-haiku-5-5");
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new KeyCheckError("Anthropic refused this key.", true);
      }
      if (error instanceof Anthropic.APIError) throw new KeyCheckError(`Anthropic answered ${error.status ?? "an error"}.`, false);
      throw new KeyCheckError("Anthropic could not be reached from the panel.", false);
    }
  },
};

let provider: ModelProvider = anthropicProvider;

export function modelProvider(): ModelProvider {
  return provider;
}

/** Tests swap in a scripted provider; null restores the real one. */
export function setModelProvider(next: ModelProvider | null): void {
  provider = next ?? anthropicProvider;
}

export { Anthropic };
