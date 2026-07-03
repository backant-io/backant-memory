import { join } from "node:path";
import type { RepoIdentity } from "./repo-identity.js";
import { API_BASE_URL } from "../constants.js";

export interface ProvisionResponse {
  syncUrl: string;
  namespace: string;
  scopedToken: string;
}

export interface ResolveInput {
  identity: RepoIdentity;
  kairosHome: string;
  token: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface Connection {
  localPath: string;
  syncUrl?: string;
  authToken?: string;
  namespace: string;
}

/**
 * Resolve the libSQL connection for a repo. Local-only identities (no git
 * origin) stay on a local file and never call the backend. Remote identities
 * ask the backant backend to provision (create-if-absent) the owner namespace
 * and mint a namespace-scoped token, then open an embedded replica of it.
 */
export async function resolveConnection(input: ResolveInput): Promise<Connection> {
  const memDir = join(input.kairosHome, "memory");

  if (input.identity.isLocalOnly) {
    return { localPath: join(memDir, "ns-__local__.db"), namespace: "__local__" };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const res = await doFetch(`${input.baseUrl ?? API_BASE_URL}/kairos/memory/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
    body: JSON.stringify({ owner: input.identity.owner }),
  });
  if (!res.ok) {
    throw new Error(`memory provision failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ProvisionResponse;
  return {
    localPath: join(memDir, `ns-${body.namespace}.db`),
    syncUrl: body.syncUrl,
    authToken: body.scopedToken,
    namespace: body.namespace,
  };
}
