import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEditor } from "./FileEditor";

const mocks = vi.hoisted(() => ({ loadEditableFile: vi.fn(), saveEditableFile: vi.fn() }));
vi.mock("./api", () => mocks);

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
});
