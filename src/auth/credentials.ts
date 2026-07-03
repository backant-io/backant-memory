import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../constants.js";

export interface Credentials {
  access_token: string;
  client_id: string;
  refresh_token?: string;
}

export function saveCredentials(creds: Credentials, dir?: string): void {
  const targetDir = dir ?? CONFIG_DIR;
  const targetFile = join(targetDir, "credentials.json");
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(targetFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadCredentials(dir?: string): Credentials | null {
  const targetFile = join(dir ?? CONFIG_DIR, "credentials.json");
  if (!existsSync(targetFile)) {
    return null;
  }
  try {
    const data = readFileSync(targetFile, "utf-8");
    return JSON.parse(data) as Credentials;
  } catch {
    return null;
  }
}

export function deleteCredentials(dir?: string): void {
  const targetFile = join(dir ?? CONFIG_DIR, "credentials.json");
  if (existsSync(targetFile)) {
    rmSync(targetFile);
  }
}
