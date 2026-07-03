import { OllamaClient } from "./client.js";

export interface EmbedderOptions {
  client: OllamaClient;
  model: string;
}

export class Embedder {
  constructor(private readonly opts: EmbedderOptions) {}

  async embed(text: string): Promise<Float32Array> {
    return this.opts.client.embed({ model: this.opts.model, input: text });
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }
}
