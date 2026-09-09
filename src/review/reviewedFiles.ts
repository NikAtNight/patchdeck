import type { Comparison } from "../types";
import { readStoredReviewedFingerprints, writeStoredReviewedFingerprints, readStoredReviewedFiles, writeStoredReviewedFiles } from "./reviewStore";

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

// Review progress follows file content, not the branch's latest commit ID.
export function readReviewProgress(repositoryPath: string, comparison: Comparison) {
  const fingerprints = readStoredReviewedFingerprints()[reviewContext(repositoryPath, comparison)] ?? {};
  const legacy = comparison.mode !== "workingTree"
    ? readReviewedPaths(repositoryPath, comparison.mergeBase, comparison.compareCommit)
    : new Set<string>();
  const viewed = new Set<string>();
  const changed = new Set<string>();
  for (const file of comparison.files) {
    const previous = fingerprints[file.path];
    if (file.fingerprint && previous) {
      if (previous === file.fingerprint) viewed.add(file.path);
      else changed.add(file.path);
    } else if (legacy.has(file.path)) {
      viewed.add(file.path);
    }
  }
  return { viewed, changed };
}

export function writeReviewProgress(repositoryPath: string, comparison: Comparison, viewed: ReadonlySet<string>) {
  const key = reviewContext(repositoryPath, comparison);
  const all = readStoredReviewedFingerprints();
  const fingerprints = { ...all[key] };
  for (const file of comparison.files) {
    if (viewed.has(file.path) && file.fingerprint) fingerprints[file.path] = file.fingerprint;
    else if (fingerprints[file.path] === file.fingerprint) delete fingerprints[file.path];
  }
  writeStoredReviewedFingerprints({ ...all, [key]: fingerprints });
  if (comparison.mode !== "workingTree") writeReviewedPaths(repositoryPath, comparison.mergeBase, comparison.compareCommit, viewed);
}

function reviewContext(repositoryPath: string, comparison: Comparison) {
  return JSON.stringify([repositoryPath, comparison.baseBranch, comparison.compareBranch, comparison.mode ?? "branch"]);
}
