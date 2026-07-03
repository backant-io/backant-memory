import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedPaths {
  home: string;          // BACKANT_MEMORY_HOME, default ~/.claude/kairos (shared with kairos, spec D4)
  dbDir: string;         // <home>/memory
  port: number;          // BACKANT_MEMORY_PORT, default 41414
  tokenPath: string;     // <home>/memory/.backant-memory-token
  ollamaUrl: string;     // BACKANT_MEMORY_OLLAMA_URL ?? KAIROS_OLLAMA_URL ?? http://127.0.0.1:11434
  embeddingModel: string;// BACKANT_MEMORY_EMBEDDING_MODEL ?? KAIROS_EMBEDDING_MODEL ?? qwen3-embedding:0.6b
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const home = env.BACKANT_MEMORY_HOME ?? join(homedir(), ".claude/kairos");
  const dbDir = join(home, "memory");
  return {
    home,
    dbDir,
    port: Number(env.BACKANT_MEMORY_PORT ?? 41414),
    tokenPath: join(dbDir, ".backant-memory-token"),
    ollamaUrl: env.BACKANT_MEMORY_OLLAMA_URL ?? env.KAIROS_OLLAMA_URL ?? "http://127.0.0.1:11434",
    embeddingModel: env.BACKANT_MEMORY_EMBEDDING_MODEL ?? env.KAIROS_EMBEDDING_MODEL ?? "qwen3-embedding:0.6b",
  };
}
