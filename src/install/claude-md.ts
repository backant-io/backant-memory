import { existsSync, readFileSync, writeFileSync } from "node:fs";

const START = "<!-- backant-memory:start -->";
const END = "<!-- backant-memory:end -->";

export function upsertManagedBlock(filePath: string, content: string): void {
  const block = `${START}\n${content}\n${END}\n`;
  if (!existsSync(filePath)) { writeFileSync(filePath, block); return; }
  const cur = readFileSync(filePath, "utf8");
  const s = cur.indexOf(START), e = cur.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    const next = cur.slice(0, s) + block + cur.slice(e + END.length + (cur[e + END.length] === "\n" ? 1 : 0));
    if (next !== cur) writeFileSync(filePath, next);
    return;
  }
  writeFileSync(filePath, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + block);
}

export function removeManagedBlock(filePath: string): void {
  if (!existsSync(filePath)) return;
  const cur = readFileSync(filePath, "utf8");
  const s = cur.indexOf(START), e = cur.indexOf(END);
  if (s === -1 || e === -1 || e < s) return;
  writeFileSync(filePath, cur.slice(0, s) + cur.slice(e + END.length + (cur[e + END.length] === "\n" ? 1 : 0)));
}
