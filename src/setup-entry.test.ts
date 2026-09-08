import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { expect, it } from "vitest";
import setup from "../setup-entry.js";

it("loads setup metadata with no static transport or tool implementation dependency", () => {
  expect(setup.plugin.id).toBe("sabha");
  const visited = new Set<string>();
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^import(?! type\b)[\s\S]*?from "(\.[^"]+)";/gm)) {
      visit(resolve(dirname(path), match[1].replace(/\.js$/, ".ts")));
    }
  }
  visit(resolve("setup-entry.ts"));
  for (const name of ["monitor", "monitor-websocket", "draft-stream", "tools", "client", "channel"]) {
    expect(visited.has(resolve(`src/${name}.ts`)), name).toBe(false);
  }
});
