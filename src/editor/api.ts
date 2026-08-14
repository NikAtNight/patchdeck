import { invoke } from "@tauri-apps/api/core";

export interface EditableFile {
  path: string;
  content: string;
  hash: string;
}

export const loadEditableFile = (repositoryPath: string, path: string) =>
  invoke<EditableFile>("load_editable_file", { repositoryPath, path });

export const saveEditableFile = (repositoryPath: string, path: string, expectedHash: string, content: string) =>
  invoke<EditableFile>("save_editable_file", { repositoryPath, path, expectedHash, content });
