import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { BranchPicker } from "./BranchPicker";

afterEach(cleanup);
const branches = ["main", "feature/SXCL-1321", "feature/SXCL-1322"].map((name) => ({ name, commit: "aaa" }));
function setup() {
  const onChange = vi.fn();
  render(<><label htmlFor="base">Base</label><BranchPicker id="base" branches={branches} value="main" onChange={onChange} /></>);
  return { input: screen.getByRole("combobox", { name: "Base" }), onChange };
}

it("filters by case-insensitive partial name and commits a clicked result", () => {
  const { input, onChange } = setup();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "sxcl-132" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option", { name: "feature/SXCL-1322" }));
  expect(onChange).toHaveBeenCalledWith("feature/SXCL-1322");
  expect(input).toHaveAttribute("aria-expanded", "false");
});

it("supports arrows and Enter, and restores the selection on Escape or blur", () => {
  const { input, onChange } = setup();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "feature" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  const option = screen.getByRole("option", { name: "feature/SXCL-1322" });
  expect(input).toHaveAttribute("aria-activedescendant", option.id);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("feature/SXCL-1322");
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "abandoned" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("main");
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "other" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("main");
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("shows an empty result without allowing arbitrary branch names", () => {
  const { input, onChange } = setup();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "does-not-exist" } });
  expect(screen.getByRole("status")).toHaveTextContent("No matching branches");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
});

it("disables the picker for a repository without branches", () => {
  render(<BranchPicker id="empty" branches={[]} value="" onChange={vi.fn()} />);
  expect(screen.getByRole("combobox")).toBeDisabled();
});
