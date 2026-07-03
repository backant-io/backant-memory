export interface OllamaClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface EmbedRequest {
  model: string;
  input: string;
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "http://127.0.0.1:11434";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async embed(req: EmbedRequest): Promise<Float32Array> {
    const res = await this.post("/api/embed", {
      model: req.model,
      input: req.input,
    });
    const json = (await res.json()) as { embeddings: number[][] };
    const arr = json.embeddings?.[0];
    if (!Array.isArray(arr)) {
      throw new Error(`Ollama returned no embedding for input`);
    }
    return new Float32Array(arr);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
    const json = (await res.json()) as { models: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }

  async pull(
    model: string,
    onProgress?: (event: { status: string; completed?: number; total?: number; error?: string }) => void,
    opts: { idleTimeoutMs?: number } = {}
  ): Promise<{ status: string }> {
    const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => controller.abort(new Error(`Ollama /api/pull idle for ${idleTimeoutMs}ms`)),
        idleTimeoutMs
      );
    };

    try {
      const res = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`Ollama /api/pull returned ${res.status}: ${text}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let last: { status?: string; error?: string } = {};
      resetIdleTimer();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdleTimer();
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            last = event;
            onProgress?.(event);
          } catch {
            // skip malformed line
          }
        }
      }
      if (last.error) throw new Error(`Ollama pull error: ${last.error}`);
      if (last.status !== "success") {
        throw new Error(`Ollama pull did not reach 'success' (last status: ${last.status ?? "none"})`);
      }
      return { status: "success" };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${path} returned ${res.status}: ${text}`);
    }
    return res;
  }
}
