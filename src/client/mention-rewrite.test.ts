import { describe, it, expect } from "vitest";
import { MentionRewriter } from "./mention-rewrite.js";

describe("MentionRewriter", () => {
  it("rewrites @Name to @{id} for a known user", () => {
    const r = new MentionRewriter();
    r.add("Ashwin M", 1);
    expect(r.rewrite("Hey @Ashwin M, check this")).toBe("Hey @{1}, check this");
  });

  it("rewrites case-insensitively", () => {
    const r = new MentionRewriter();
    r.add("Ashwin M", 1);
    expect(r.rewrite("Hey @ashwin m!")).toBe("Hey @{1}!");
  });

  it("rewrites at end of string", () => {
    const r = new MentionRewriter();
    r.add("Alice", 42);
    expect(r.rewrite("Thanks @Alice")).toBe("Thanks @{42}");
  });

  it("rewrites multiple occurrences", () => {
    const r = new MentionRewriter();
    r.add("Alice", 42);
    expect(r.rewrite("@Alice and @Alice again")).toBe("@{42} and @{42} again");
  });

  it("rewrites multiple different users", () => {
    const r = new MentionRewriter();
    r.add("Alice", 1);
    r.add("Bob", 2);
    expect(r.rewrite("@Alice and @Bob")).toBe("@{1} and @{2}");
  });

  it("does not double-rewrite existing @{id} tokens", () => {
    const r = new MentionRewriter();
    r.add("Alice", 42);
    expect(r.rewrite("@{42} is fine")).toBe("@{42} is fine");
  });

  it("rewrites Discord-style <@id> to @{id} for known ids", () => {
    const r = new MentionRewriter();
    r.add("Alice", 42);
    expect(r.rewrite("Hey <@42>!")).toBe("Hey @{42}!");
  });

  it("leaves <@id> alone for unknown ids", () => {
    const r = new MentionRewriter();
    r.add("Alice", 42);
    expect(r.rewrite("Hey <@999>")).toBe("Hey <@999>");
  });

  it("prefers longer name match over shorter prefix", () => {
    const r = new MentionRewriter();
    r.add("Ash", 10);
    r.add("Ashwin M", 1);
    expect(r.rewrite("@Ashwin M said hi")).toBe("@{1} said hi");
  });

  it("returns text unchanged when no users registered", () => {
    const r = new MentionRewriter();
    expect(r.rewrite("@Nobody here")).toBe("@Nobody here");
  });

  it("returns text unchanged for unknown names", () => {
    const r = new MentionRewriter();
    r.add("Alice", 1);
    expect(r.rewrite("@Bob said")).toBe("@Bob said");
  });

  it("handles empty text", () => {
    const r = new MentionRewriter();
    r.add("Alice", 1);
    expect(r.rewrite("")).toBe("");
  });

  it("skips invalid add calls", () => {
    const r = new MentionRewriter();
    r.add("", 1);
    r.add("Alice", 0);
    r.add("Bob", -1);
    expect(r.size).toBe(0);
  });

  it("overwrites duplicate names", () => {
    const r = new MentionRewriter();
    r.add("Alice", 1);
    r.add("Alice", 42);
    expect(r.size).toBe(1);
    expect(r.rewrite("@Alice")).toBe("@{42}");
  });

  it("handles name with regex-special characters", () => {
    const r = new MentionRewriter();
    r.add("Test (User)", 5);
    expect(r.rewrite("@Test (User) hi")).toBe("@{5} hi");
  });

  it("does not match @Name inside a word", () => {
    const r = new MentionRewriter();
    r.add("Al", 1);
    // @Alice contains @Al as prefix but "ice" follows as a word char
    expect(r.rewrite("@Alice")).toBe("@Alice");
  });
});
