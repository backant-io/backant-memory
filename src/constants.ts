import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".backant-kairos");
export const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const API_BASE_URL = "https://mcp.backant.io";
