import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEditor } from "./FileEditor";
import type { EditableFile } from "./api";

const mocks = vi.hoisted(() => ({ loadEditableFile: vi.fn(), saveEditableFile: vi.fn() }));
vi.mock("./api", () => mocks);

function deferredFile() {
  let resolve!: (file: EditableFile) => void;
  const promise = new Promise<EditableFile>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe("guarded file editor", () => {
  beforeEach(() => {
    mocks.loadEditableFile.mockReset().mockResolvedValue({ path: "src/example.ts", content: "before\n", hash: "old-hash" });
    mocks.saveEditableFile.mockReset().mockResolvedValue({ path: "src/example.ts", content: "after\n", hash: "new-hash" });
  });
  afterEach(cleanup);

  it("saves with the loaded optimistic concurrency hash", async () => {
    const onSaved = vi.fn();
    render(<FileEditor repositoryPath="/work/product" path="src/example.ts" onClose={vi.fn()} onSaved={onSaved} />);
    const editor = await screen.findByLabelText("File contents");
    fireEvent.change(editor, { target: { value: "after\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    await waitFor(() => expect(mocks.saveEditableFile).toHaveBeenCalledWith(
      "/work/product", "src/example.ts", "old-hash", "after\n",
    ));
    expect(await screen.findByText("Saved on disk")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("preserves typing during a save and uses the returned hash on the next save", async () => {
    const pendingSave = deferredFile();
    mocks.saveEditableFile.mockReturnValueOnce(pendingSave.promise);
    const onSaved = vi.fn();
    render(<FileEditor repositoryPath="/work/product" path="src/example.ts" onClose={vi.fn()} onSaved={onSaved} />);
    const editor = await screen.findByLabelText("File contents");
    fireEvent.change(editor, { target: { value: "after\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    fireEvent.change(editor, { target: { value: "after plus more typing\n" } });

    await act(async () => pendingSave.resolve({ path: "src/example.ts", content: "after\n", hash: "saved-hash" }));

    expect(editor).toHaveValue("after plus more typing\n");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
    mocks.saveEditableFile.mockResolvedValueOnce({ path: "src/example.ts", content: "after plus more typing\n", hash: "latest-hash" });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    await waitFor(() => expect(mocks.saveEditableFile).toHaveBeenLastCalledWith(
      "/work/product", "src/example.ts", "saved-hash", "after plus more typing\n",
    ));
    expect(await screen.findByText("Saved on disk")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it("keeps edits after a save failure and allows retry with the existing hash", async () => {
    mocks.saveEditableFile.mockRejectedValueOnce(new Error("Could not write file"));
    const onSaved = vi.fn();
    render(<FileEditor repositoryPath="/work/product" path="src/example.ts" onClose={vi.fn()} onSaved={onSaved} />);
    const editor = await screen.findByLabelText("File contents");
    fireEvent.change(editor, { target: { value: "after\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not write file");
    expect(editor).toHaveValue("after\n");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    expect(await screen.findByText("Saved on disk")).toBeInTheDocument();
    expect(mocks.saveEditableFile).toHaveBeenLastCalledWith("/work/product", "src/example.ts", "old-hash", "after\n");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("shows a failed load and retries it without leaving a loading indicator", async () => {
    mocks.loadEditableFile.mockRejectedValueOnce(new Error("Could not read file"));
    render(<FileEditor repositoryPath="/work/product" path="src/example.ts" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read file");
    expect(screen.queryByText("Loading working tree file…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save file" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("File contents")).toHaveValue("before\n");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.loadEditableFile).toHaveBeenCalledTimes(2);
  });

  it("ignores an earlier file load after switching paths", async () => {
    const pendingLoad = deferredFile();
    mocks.loadEditableFile.mockReturnValueOnce(pendingLoad.promise);
    const props = { repositoryPath: "/work/product", onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<FileEditor {...props} path="src/old.ts" />);
    rerender(<FileEditor {...props} path="src/example.ts" />);
    const editor = await screen.findByLabelText("File contents");
    fireEvent.change(editor, { target: { value: "current edits\n" } });

    await act(async () => pendingLoad.resolve({ path: "src/old.ts", content: "outdated load\n", hash: "outdated-hash" }));

    expect(editor).toHaveValue("current edits\n");
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    await waitFor(() => expect(mocks.saveEditableFile).toHaveBeenCalledWith(
      "/work/product", "src/example.ts", "old-hash", "current edits\n",
    ));
  });

  it("ignores a previous file's save response after switching repositories", async () => {
    const pendingSave = deferredFile();
    mocks.saveEditableFile.mockReturnValueOnce(pendingSave.promise);
    const props = { path: "src/example.ts", onClose: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(<FileEditor {...props} repositoryPath="/work/old" />);
    fireEvent.change(await screen.findByLabelText("File contents"), { target: { value: "old repository edits\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    mocks.loadEditableFile.mockResolvedValueOnce({ path: "src/example.ts", content: "new repository\n", hash: "current-hash" });
    rerender(<FileEditor {...props} repositoryPath="/work/current" />);
    const editor = await screen.findByLabelText("File contents");
    fireEvent.change(editor, { target: { value: "new repository edits\n" } });

    await act(async () => pendingSave.resolve({ path: "src/example.ts", content: "old repository edits\n", hash: "old-save-hash" }));

    expect(editor).toHaveValue("new repository edits\n");
    expect(props.onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save file" }));
    await waitFor(() => expect(mocks.saveEditableFile).toHaveBeenLastCalledWith(
      "/work/current", "src/example.ts", "current-hash", "new repository edits\n",
    ));
  });
});
