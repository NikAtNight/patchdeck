import type { DiffHunk } from "../types";

export interface ChangedRange {
  start: number;
  end: number;
}

interface TokenWithContent {
  content: string;
}

export type IntralineToken<T extends TokenWithContent> = T & {
  inRange: boolean;
};

export function getIntralineRanges(hunk: Pick<DiffHunk, "lines">): Map<number, ChangedRange> {
  const ranges = new Map<number, ChangedRange>();

  for (let index = 0; index < hunk.lines.length;) {
    if (hunk.lines[index].kind !== "deletion") {
      index += 1;
      continue;
    }

    const deletionStart = index;
    while (index < hunk.lines.length && hunk.lines[index].kind === "deletion") index += 1;
    const additionStart = index;
    while (index < hunk.lines.length && hunk.lines[index].kind === "addition") index += 1;

    for (let pairIndex = 0; pairIndex < Math.min(additionStart - deletionStart, index - additionStart); pairIndex += 1) {
      const deletionIndex = deletionStart + pairIndex;
      const additionIndex = additionStart + pairIndex;
      const pairRanges = changedRanges(hunk.lines[deletionIndex].content, hunk.lines[additionIndex].content);
      if (!pairRanges) continue;
      ranges.set(deletionIndex, pairRanges.deletion);
      ranges.set(additionIndex, pairRanges.addition);
    }
  }

  return ranges;
}

export function splitTokensAtRange<T extends TokenWithContent>(
  tokens: readonly T[],
  range: ChangedRange,
): IntralineToken<T>[] {
  const result: IntralineToken<T>[] = [];
  let offset = 0;

  for (const token of tokens) {
    const characters = Array.from(token.content);
    const tokenEnd = offset + characters.length;
    const boundaries = [offset, range.start, range.end, tokenEnd]
      .filter((boundary) => boundary >= offset && boundary <= tokenEnd)
      .sort((left, right) => left - right);

    if (characters.length === 0) {
      result.push({ ...token, inRange: false });
    } else {
      for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
        const start = boundaries[boundaryIndex];
        const end = boundaries[boundaryIndex + 1];
        if (start === end) continue;
        result.push({
          ...token,
          content: characters.slice(start - offset, end - offset).join(""),
          inRange: start >= range.start && end <= range.end,
        });
      }
    }

    offset = tokenEnd;
  }

  return result;
}

function changedRanges(deletion: string, addition: string): { deletion: ChangedRange; addition: ChangedRange } | null {
  const deletionCharacters = Array.from(deletion);
  const additionCharacters = Array.from(addition);
  let start = 0;

  while (
    start < deletionCharacters.length
    && start < additionCharacters.length
    && deletionCharacters[start] === additionCharacters[start]
  ) start += 1;

  let deletionEnd = deletionCharacters.length;
  let additionEnd = additionCharacters.length;
  while (
    deletionEnd > start
    && additionEnd > start
    && deletionCharacters[deletionEnd - 1] === additionCharacters[additionEnd - 1]
  ) {
    deletionEnd -= 1;
    additionEnd -= 1;
  }

  if (deletionEnd === start && additionEnd === start) return null;

  const changedLength = Math.max(deletionEnd - start, additionEnd - start);
  const longerLineLength = Math.max(deletionCharacters.length, additionCharacters.length);
  if (changedLength / longerLineLength > 0.7) return null;

  return {
    deletion: { start, end: deletionEnd },
    addition: { start, end: additionEnd },
  };
}
