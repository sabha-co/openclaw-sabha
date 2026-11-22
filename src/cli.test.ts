import { describe, expect, it } from "vitest";
import { restartCommand } from "./cli.js";

describe("restartCommand", () => {
  it.each([
    [true, false, "sudo systemctl restart openclaw-gateway"],
    [true, true, "openclaw gateway restart"],
    [false, true, "openclaw gateway restart"],
    [false, false, "openclaw gateway restart"],
  ])("a system unit %s, a user unit %s: %s", (systemUnit, userUnit, command) => {
    expect(restartCommand({ systemUnit, userUnit })).toBe(command);
  });
});
