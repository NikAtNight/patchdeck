import type { ChangedFile, FileStatus } from "../types";
import { AlertIcon } from "./icons";

export const FILE_STATUS_LABELS: Record<FileStatus, [string, string]> = {
  added: ["A", "Added"],
  modified: ["M", "Modified"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  type_changed: ["T", "Type changed"],
  unmerged: ["U", "Unmerged"],
  unknown: ["?", "Changed"],
};

export function accessibleFileLabel(file: ChangedFile) {
  const status = FILE_STATUS_LABELS[file.status][1];
  if (file.binary || file.additions === null || file.deletions === null) {
    return `${file.path}, ${status}, binary file`;
  }
  return `${file.path}, ${status}, ${file.additions} additions, ${file.deletions} deletions`;
}

export function StatusBadge({ status, compact = false }: { status: FileStatus; compact?: boolean }) {
  const [short, label] = FILE_STATUS_LABELS[status];
  return <span className={`status-badge ${status}${compact ? " compact" : ""}`} title={label}>{short}{!compact && <span>{label}</span>}</span>;
}

export function FileCounts({ file, compact = false }: { file: ChangedFile; compact?: boolean }) {
  if (file.binary || file.additions === null || file.deletions === null) {
    return <span className={`binary-label${compact ? " compact" : ""}`}>BIN</span>;
  }
  return (
    <span className={`file-counts${compact ? " compact" : ""}`} aria-label={`${file.additions} additions and ${file.deletions} deletions`}>
      <span className="additions">+{file.additions}</span>
      <span className="deletions">−{file.deletions}</span>
    </span>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner" role="alert"><AlertIcon /><span>{message}</span></div>;
}

export function Spinner() { return <span className="spinner" aria-hidden="true" />; }

export function FileListSkeleton() {
  return <div className="file-list skeleton-list">{Array.from({ length: 7 }, (_, index) => <div className="skeleton-row" key={index}><i /><span /></div>)}</div>;
}

export function DiffSkeleton({ embedded = false }: { embedded?: boolean }) {
  return <div className={`diff-skeleton${embedded ? " embedded" : ""}`}><div className="skeleton-title" />{Array.from({ length: 12 }, (_, index) => <div className="skeleton-code" style={{ width: `${48 + (index * 17) % 44}%` }} key={index} />)}</div>;
}
