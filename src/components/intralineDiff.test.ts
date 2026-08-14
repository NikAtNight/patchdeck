import { describe, expect, it } from "vitest";
import type { DiffHunk } from "../types";
import { getIntralineRanges, splitTokensAtRange } from "./intralineDiff";

function hunk(contents: Array<[DiffHunk["lines"][number]["kind"], string]>): DiffHunk {
  return {
    header: "@@ -1,1 +1,1 @@",
    lines: contents.map(([kind, content], index) => ({
      kind,
      content,
      oldLine: kind === "addition" ? null : index + 1,
      newLine: kind === "deletion" ? null : index + 1,
    })),
  };
}

describe("getIntralineRanges", () => {
  it("pairs matching positions in unequal deletion and addition runs", () => {
    const ranges = getIntralineRanges(hunk([
      ["deletion", "keep one"],
      ["deletion", "keep two"],
      ["deletion", "unpaired"],
      ["addition", "keep one!"],
      ["addition", "keep too"],
    ]));

    expect([...ranges.entries()]).toEqual([
      [0, { start: 8, end: 8 }],
      [3, { start: 8, end: 9 }],
      [1, { start: 6, end: 7 }],
      [4, { start: 6, end: 7 }],
    ]);
    expect(ranges.has(2)).toBe(false);
  });

  it("trims shared prefixes and suffixes", () => {
    const ranges = getIntralineRanges(hunk([
      ["deletion", "const answer = 41;"],
      ["addition", "const answer = 42;"],
    ]));

    expect(ranges.get(0)).toEqual({ start: 16, end: 17 });
    expect(ranges.get(1)).toEqual({ start: 16, end: 17 });
  });

  it("skips whole-line rewrites", () => {
    const ranges = getIntralineRanges(hunk([
      ["deletion", "before everything changed"],
      ["addition", "after everything replaced"],
    ]));

    expect(ranges.size).toBe(0);
  });

  it("uses code-point offsets at emoji boundaries", () => {
    const ranges = getIntralineRanges(hunk([
      ["deletion", "before 😀x after"],
      ["addition", "before 😀y after"],
    ]));

    expect(ranges.get(0)).toEqual({ start: 8, end: 9 });
    expect(ranges.get(1)).toEqual({ start: 8, end: 9 });
  });

  it("handles empty lines without ranges", () => {
    const ranges = getIntralineRanges(hunk([
      ["deletion", ""],
      ["addition", ""],
    ]));

    expect(ranges.size).toBe(0);
  });
});

describe("splitTokensAtRange", () => {
  it("splits token boundaries without losing content and flags only the changed pieces", () => {
    const pieces = splitTokensAtRange([
      { content: "const ", types: ["keyword"] },
      { content: "answer", types: ["variable"] },
      { content: " = 42;", types: ["plain"] },
    ], { start: 8, end: 13 });

    expect(pieces.map(({ content }) => content).join("")).toBe("const answer = 42;");
    expect(pieces).toEqual([
      { content: "const ", types: ["keyword"], inRange: false },
      { content: "an", types: ["variable"], inRange: false },
      { content: "swer", types: ["variable"], inRange: true },
      { content: " ", types: ["plain"], inRange: true },
      { content: "= 42;", types: ["plain"], inRange: false },
    ]);
  });

  it("does not split surrogate pairs at range boundaries", () => {
    const pieces = splitTokensAtRange([{ content: "😀xy", types: ["plain"] }], { start: 1, end: 2 });

    expect(pieces).toEqual([
      { content: "😀", types: ["plain"], inRange: false },
      { content: "x", types: ["plain"], inRange: true },
      { content: "y", types: ["plain"], inRange: false },
    ]);
  });
});
