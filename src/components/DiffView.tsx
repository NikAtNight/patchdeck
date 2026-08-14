import { Fragment, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Highlight } from "prism-react-renderer";
import { syntaxTheme } from "../prismTheme";
import type { ChangedFile, DiffLineKind, FileDiff } from "../types";
import type { InlineReviewComment, ReviewTarget } from "../review/inlineComments";
import { AlertIcon, BinaryIcon, CheckIcon, LargeFileIcon, WrapIcon } from "./icons";
import { getIntralineRanges, splitTokensAtRange } from "./intralineDiff";
import { DiffSkeleton, FileCounts, StatusBadge } from "./ui";
import "./intralineDiff.css";

export interface DiffCommentAnchor {
  side: "old" | "new";
  line: number;
  context: string;
}

export function DiffView({
  file,
  diff,
  error,
  loading,
  wrapLines,
  onToggleWrap,
  onRetry,
  showEdit,
  canEdit,
  onEdit,
  reviewTarget,
  comments,
  onAddComment,
  onUpdateComment,
  onSendFeedback,
  feedbackStatus,
  onClearReviewTarget,
  viewed,
  onToggleViewed,
}: {
  file: ChangedFile;
  diff?: FileDiff;
  error?: string;
  loading: boolean;
  wrapLines: boolean;
  onToggleWrap: () => void;
  onRetry: () => void;
  showEdit: boolean;
  canEdit: boolean;
  onEdit: () => void;
  reviewTarget: ReviewTarget | null;
  comments: InlineReviewComment[];
  onAddComment: (anchor: DiffCommentAnchor, body: string) => void;
  onUpdateComment: (commentId: string, state: InlineReviewComment["state"]) => void;
  onSendFeedback: () => Promise<void>;
  feedbackStatus: string | null;
  onClearReviewTarget: () => void;
  viewed: boolean;
  onToggleViewed: () => void;
}) {
  const [commentAnchor, setCommentAnchor] = useState<DiffCommentAnchor | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const pendingComments = comments.filter((comment) => comment.state === "open" && comment.sentAt === null).length;

  function submitComment(event: FormEvent) {
    event.preventDefault();
    if (!commentAnchor || !commentBody.trim()) return;
    onAddComment(commentAnchor, commentBody.trim());
    setCommentAnchor(null);
    setCommentBody("");
  }

  return (
    <div className={`diff-view${wrapLines ? " wrap-lines" : " no-wrap-lines"}`}>
      <header className="file-header">
        <div className="file-title-row">
          <StatusBadge status={file.status} />
          <div className="file-title">
            <div>{file.path}</div>
            {file.oldPath && <span>renamed from {file.oldPath}</span>}
          </div>
        </div>
        <div className="file-header-actions">
          {reviewTarget && <button className="review-task-chip" title={`Reviewing ${reviewTarget.title}`} onClick={onClearReviewTarget}>{reviewTarget.taskId} ×</button>}
          <FileCounts file={file} />
          <label className={`viewed-toggle${viewed ? " active" : ""}`}>
            <input type="checkbox" checked={viewed} onChange={onToggleViewed} aria-label={`Mark ${file.path} as viewed`} />
            Viewed
          </label>
          {reviewTarget && pendingComments > 0 && (
            <button className="send-feedback-button" onClick={() => void onSendFeedback()}>
              {reviewTarget.status === "review" ? "Request changes" : "Send feedback"} · {pendingComments}
            </button>
          )}
          {showEdit && <button className="edit-file-button" type="button" disabled={!canEdit} title={canEdit ? "Edit this working tree file" : "Editing requires the compare branch to be checked out"} onClick={onEdit}>Edit</button>}
          <button
            className={`wrap-toggle${wrapLines ? " active" : ""}`}
            type="button"
            aria-pressed={wrapLines}
            aria-label={wrapLines ? "Disable line wrapping" : "Enable line wrapping"}
            title={wrapLines ? "Show long lines with horizontal scrolling" : "Wrap long lines to the available width"}
            onClick={onToggleWrap}
          >
            <WrapIcon />
            <span>Wrap</span>
          </button>
        </div>
      </header>
      {feedbackStatus && <div className="feedback-status" role="status">{feedbackStatus}</div>}

      {file.binary || diff?.binary ? (
        <div className="diff-message"><BinaryIcon /><h2>Binary file</h2><p>This file changed, but it cannot be displayed as text.</p></div>
      ) : error ? (
        <div className="diff-message error-state"><AlertIcon /><h2>Could not load this diff</h2><p>{error}</p><button className="secondary-button" onClick={onRetry}>Try again</button></div>
      ) : loading || !diff ? (
        <DiffSkeleton embedded />
      ) : diff.tooLarge ? (
        <div className="diff-message"><LargeFileIcon /><h2>Diff too large to display</h2><p>The file is listed in the comparison, but its patch exceeds the 5 MB rendering limit.</p></div>
      ) : diff.hunks.length === 0 ? (
        <div className="diff-message"><CheckIcon /><h2>No textual changes</h2><p>Git did not return any text hunks for this file.</p></div>
      ) : (
        <div className="diff-scroll">
          {diff.hunks.map((hunk, hunkIndex) => (
            <DiffHunk
              key={`${hunk.header}-${hunkIndex}`}
              hunk={hunk}
              hunkIndex={hunkIndex}
              filePath={file.path}
              comments={comments}
              reviewTarget={reviewTarget}
              commentAnchor={commentAnchor}
              commentBody={commentBody}
              onSetCommentAnchor={setCommentAnchor}
              onSetCommentBody={setCommentBody}
              onSubmitComment={submitComment}
              onUpdateComment={onUpdateComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiffHunk({
  hunk,
  hunkIndex,
  filePath,
  comments,
  reviewTarget,
  commentAnchor,
  commentBody,
  onSetCommentAnchor,
  onSetCommentBody,
  onSubmitComment,
  onUpdateComment,
}: {
  hunk: FileDiff["hunks"][number];
  hunkIndex: number;
  filePath: string;
  comments: InlineReviewComment[];
  reviewTarget: ReviewTarget | null;
  commentAnchor: DiffCommentAnchor | null;
  commentBody: string;
  onSetCommentAnchor: (anchor: DiffCommentAnchor | null) => void;
  onSetCommentBody: (body: string) => void;
  onSubmitComment: (event: FormEvent) => void;
  onUpdateComment: (commentId: string, state: InlineReviewComment["state"]) => void;
}) {
  const intralineRanges = useMemo(() => getIntralineRanges(hunk), [hunk]);

  return (
    <div className="diff-hunk">
      <div className="hunk-header"><span>•••</span>{hunk.header}</div>
      <Highlight theme={syntaxTheme} code={hunk.lines.map((line) => line.content || " ").join("\n")} language={languageForPath(filePath)}>
        {({ tokens, getTokenProps }) => <div className="diff-lines">
          {hunk.lines.map((line, lineIndex) => {
            const side = line.kind === "deletion" ? "old" : "new";
            const lineNumber = side === "old" ? line.oldLine : line.newLine;
            const anchor = lineNumber ? { side, line: lineNumber, context: line.content } as DiffCommentAnchor : null;
            const anchoredComments = anchor ? comments.filter((comment) => comment.side === side && comment.line === lineNumber) : [];
            const composerOpen = anchor && commentAnchor?.side === side && commentAnchor.line === lineNumber;
            const range = intralineRanges.get(lineIndex);
            const lineTokens = range ? splitTokensAtRange(tokens[lineIndex] ?? [], range) : (tokens[lineIndex] ?? []).map((token) => ({ ...token, inRange: false }));
            return (
              <Fragment key={`${hunkIndex}-${lineIndex}`}>
                <div className={`diff-line ${line.kind}`}>
                  <span className="line-number" aria-label={line.oldLine ? `Old line ${line.oldLine}` : undefined}>{line.oldLine ?? ""}</span>
                  <span className="line-number" aria-label={line.newLine ? `New line ${line.newLine}` : undefined}>{line.newLine ?? ""}</span>
                  <span className="line-marker">
                    {reviewTarget && anchor ? (
                      <button className="line-comment-button" aria-label={`Comment on ${side} line ${lineNumber}`} title="Add review comment" onClick={() => onSetCommentAnchor(anchor)}>+</button>
                    ) : lineMarker(line.kind)}
                  </span>
                  <code><span className="sr-only">{line.content || " "}</span><span aria-hidden="true">{lineTokens.map(({ inRange, ...token }, tokenIndex) => {
                    const tokenProps = getTokenProps({ token });
                    return <span key={tokenIndex} {...tokenProps} className={`${tokenProps.className ?? ""}${inRange ? " intraline" : ""}`} />;
                  })}</span></code>
                </div>
                {anchoredComments.map((comment) => (
                  <article className={`inline-review-comment ${comment.state}${comment.sentAt ? " sent" : ""}`} key={comment.id}>
                    <strong>{comment.state === "addressed" ? "Addressed" : comment.state === "outdated" ? "Outdated" : comment.sentAt ? "Sent to Hermes" : "Pending feedback"}</strong>
                    <span>{comment.body}</span>
                    {comment.state !== "outdated" && (
                      <button
                        type="button"
                        className="inline-comment-state"
                        aria-label={comment.state === "addressed" ? "Reopen comment" : "Mark comment addressed"}
                        onClick={() => onUpdateComment(comment.id, comment.state === "addressed" ? "open" : "addressed")}
                      >
                        {comment.state === "addressed" ? "Reopen" : "Address"}
                      </button>
                    )}
                  </article>
                ))}
                {composerOpen && (
                  <form className="inline-comment-composer" onSubmit={onSubmitComment}>
                    <textarea autoFocus rows={3} value={commentBody} onChange={(event) => onSetCommentBody(event.target.value)} placeholder={`Comment on ${filePath}:${lineNumber}`} />
                    <div><button type="button" className="secondary-button" onClick={() => { onSetCommentAnchor(null); onSetCommentBody(""); }}>Cancel</button><button className="primary-button" disabled={!commentBody.trim()}>Add comment</button></div>
                  </form>
                )}
              </Fragment>
            );
          })}
        </div>}
      </Highlight>
    </div>
  );
}

function languageForPath(path: string) {
  const filename = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  const byExtension: Record<string, string> = {
    c: "c", cpp: "cpp", css: "css", go: "go", graphql: "graphql", h: "c", hbs: "handlebars",
    html: "markup", java: "java", js: "javascript", json: "json", jsx: "jsx", kt: "kotlin",
    less: "less", md: "markdown", mjs: "javascript", php: "php", py: "python", rb: "ruby",
    rs: "rust", sass: "sass", scss: "scss", sh: "bash", sql: "sql", swift: "swift",
    ts: "typescript", tsx: "tsx", vue: "markup", wasm: "wasm", xml: "markup", yaml: "yaml", yml: "yaml",
  };
  if (filename === "dockerfile") return "docker";
  if (filename === "makefile") return "makefile";
  return byExtension[extension] ?? "plain";
}

function lineMarker(kind: DiffLineKind) {
  if (kind === "addition") return "+";
  if (kind === "deletion") return "−";
  return " ";
}
