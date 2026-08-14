import { readStoredReviewedFiles, writeStoredReviewedFiles } from "./reviewStore";

type ReviewedFilesByComparison = Record<string, string[]>;

export function readReviewedPaths(
  repositoryPath: string,
  mergeBase: string,
  compareCommit: string,
): Set<string> {
  const paths = readStoredReviewedFiles()[comparisonKey(repositoryPath, mergeBase, compareCommit)];
  return new Set(paths ?? []);
}

export function writeReviewedPaths(
  repositoryPath: string,
  mergeBase: string,
  compareCommit: string,
  paths: ReadonlySet<string>,
) {
  const stored: ReviewedFilesByComparison = { ...readStoredReviewedFiles() };
  stored[comparisonKey(repositoryPath, mergeBase, compareCommit)] = [...paths].sort();
  writeStoredReviewedFiles(stored);
}

function comparisonKey(repositoryPath: string, mergeBase: string, compareCommit: string) {
  return JSON.stringify([repositoryPath, mergeBase, compareCommit]);
}
