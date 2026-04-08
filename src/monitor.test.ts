import { describe, it, expect } from "vitest";
import { buildWebSocketUrl } from "./monitor.js";

describe("buildWebSocketUrl", () => {
  it("converts http to ws and appends /cable", () => {
    const url = buildWebSocketUrl("http://localhost:3000", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc");
  });

  it("converts https to wss", () => {
    const url = buildWebSocketUrl("https://chat.example.com", "42-abc");
    expect(url).toBe("wss://chat.example.com/cable?bot_key=42-abc");
  });

  it("strips workspace path prefix", () => {
    const url = buildWebSocketUrl("http://localhost:3000/1000006", "42-abc");
    expect(url).toBe("ws://localhost:3000/cable?bot_key=42-abc");
  });

  it("uses websocketUrl when provided", () => {
    const url = buildWebSocketUrl(
      "http://localhost:3000",
      "42-abc",
      "ws://custom:8080/cable?bot_key=42-abc",
    );
    expect(url).toBe("ws://custom:8080/cable?bot_key=42-abc");
  });
});
