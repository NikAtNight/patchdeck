import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local board theme contract", () => {
  it("styles the Hermes source badge entirely with semantic theme tokens", () => {
    const boardStyles = readFileSync("src/localBoard/boards.css", "utf8");
    const hermesRule = boardStyles.match(/\.source-hermes\s*\{[^}]+\}/)?.[0] ?? "";

    expect(hermesRule).toContain("var(--info)");
    expect(hermesRule).toContain("var(--info-soft)");
    expect(hermesRule).not.toMatch(/#[\da-f]{3,8}|rgba?\(/i);
  });

  it("uses the filled-accent foreground token for the navigator action", () => {
    const boardStyles = readFileSync("src/localBoard/boards.css", "utf8");
    const actionRules = boardStyles.match(/\.board-navigator \.board-navigator-create[^}]*\{[^}]+\}/g)?.join("\n") ?? "";

    expect(actionRules).toContain("var(--accent-fill-text)");
    expect(actionRules).not.toMatch(/color:\s*white\b/i);
  });
});
