import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { describe, expect, it } from "vitest";
import { sabhaCommandDeclarations } from "./commands.js";

const spec = (name: string, extra: Partial<NativeCommandSpec> = {}): NativeCommandSpec => ({ name, description: `${name} it`, acceptsArgs: false, ...extra });

describe("sabhaCommandDeclarations", () => {
  it("puts the everyday commands first and aliases last, skips Sabha's own names and stops at Sabha's 25", () => {
    const specs = [
      spec("side", { isAlias: true }),
      spec("help"),
      spec("new", { description: "x".repeat(140) }),
      spec("model", { args: [{ name: "id", description: "", type: "string", required: true }, { name: "scope", description: "", type: "string" }] } as never),
      spec("Bad Name"),
      ...Array.from({ length: 30 }, (_, i) => spec(`skill${i}`)),
      spec("stop"),
    ];
    const declared = sabhaCommandDeclarations(specs);
    expect(declared.slice(0, 4).map((d) => d.name)).toEqual(["new", "stop", "model", "skill0"]);
    expect(declared).toHaveLength(25);
    expect(declared.some((d) => d.name === "side" || d.name === "help")).toBe(false);
    expect(declared[0]?.description).toHaveLength(100);
    expect(declared[2]?.usage_hint).toBe("<id> [scope]");
  });
});
