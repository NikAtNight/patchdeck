import { useEffect, useRef, useState } from "react";
import { loadEditableFile, saveEditableFile } from "./api";
import type { EditableFile } from "./api";
import { errorMessage } from "../errors";

export function FileEditor({ repositoryPath, path, onClose, onSaved }: {
  repositoryPath: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<EditableFile | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const fileGeneration = useRef(0);
  const dirty = file != null && content !== file.content;

  useEffect(() => {
    const generation = ++fileGeneration.current;
    setFile(null);
    setError(null);
    setSaving(false);
    loadEditableFile(repositoryPath, path)
      .then((next) => {
        if (generation !== fileGeneration.current) return;
        setFile(next);
        setContent(next.content);
      })
      .catch((reason) => {
        if (generation === fileGeneration.current) setError(errorMessage(reason));
      });
    return () => { fileGeneration.current++; };
  }, [path, repositoryPath, loadAttempt]);

  async function save() {
    if (!file || !dirty || saving) return;
    const generation = fileGeneration.current;
    setSaving(true);
    setError(null);
    try {
      const next = await saveEditableFile(repositoryPath, path, file.hash, content);
      if (generation !== fileGeneration.current) return;
      setFile(next);
      onSaved();
    } catch (reason) {
      if (generation === fileGeneration.current) setError(errorMessage(reason));
    } finally {
      if (generation === fileGeneration.current) setSaving(false);
    }
  }

  function close() {
    if (dirty && !window.confirm("Discard the unsaved changes in this editor?")) return;
    onClose();
  }

  return (
    <div className="file-editor-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <aside className="file-editor" aria-label={`Edit ${path}`}>
        <header>
          <div><span>Working tree file</span><strong>{path}</strong></div>
          <button className="plain-close" onClick={close} aria-label="Close file editor">×</button>
        </header>
        <div className="editor-safety-note">Saves are local and uncommitted. This app will never stage, commit, or push as a side effect.</div>
        {error && <div className="editor-error" role="alert">{error}</div>}
        {!file ? <div className="editor-loading">{error ? (
          <button className="secondary-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button>
        ) : "Loading working tree file…"}</div> : (
          <textarea
            className="code-editor"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            aria-label="File contents"
          />
        )}
        <footer>
          <span>{dirty ? "Unsaved changes" : file ? "Saved on disk" : ""}</span>
          <button className="secondary-button" onClick={close}>Close</button>
          <button className="primary-button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save file"}</button>
        </footer>
      </aside>
    </div>
  );
}
