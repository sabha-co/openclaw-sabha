// External plugins may import only public openclaw/plugin-sdk subpaths. The
// published package also ships private-local ones, so typechecking alone can't
// catch a private import; this test does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const { private: privateSubpaths } = JSON.parse(readFileSync(join(root, "scripts/sdk-private-subpaths.json"), "utf8")) as {
  private: string[];
};
const forbidden = new Set([...privateSubpaths, "channel-entry-contract", "plugin-runtime"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("SDK imports", () => {
  it("uses only public, non-bundled subpaths", () => {
    const files = [...sourceFiles(join(root, "src")), join(root, "setup-entry.ts"), join(root, "index.ts")];
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/["']openclaw\/plugin-sdk\/([\w-]+)["']/g)]
        .filter((match) => forbidden.has(match[1]!))
        .map((match) => `${relative(root, file)}: ${match[1]}`),
    );
    expect(offenders).toEqual([]);
  });
});
