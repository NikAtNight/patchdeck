import { useEffect, useId, useRef, useState } from "react";
import type { Branch } from "../types";
import "./BranchPicker.css";

export function BranchPicker({ id, branches, value, onChange }: {
  id: string;
  branches: Branch[];
  value: string;
  onChange: (branch: string) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const open = query !== null && branches.length > 0;
  const matches = branches.filter((branch) => branch.name.toLocaleLowerCase().includes((query ?? "").trim().toLocaleLowerCase()));
  const active = Math.min(highlight, matches.length - 1);

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, query]);

  function show() {
    if (query !== null) return;
    setQuery("");
    setHighlight(Math.max(0, branches.findIndex((branch) => branch.name === value)));
  }

  function choose(branch: string) {
    onChange(branch);
    setQuery(null);
  }

  return (
    <div className="branch-picker">
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={branches.length === 0}
        value={query ?? value}
        title={value}
        placeholder={branches.length === 0 ? "No branches" : open ? "Search branches…" : "Select a branch"}
        onFocus={show}
        onClick={show}
        onBlur={() => setQuery(null)}
        onChange={(event) => { setQuery(event.target.value); setHighlight(0); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else setHighlight(Math.max(0, Math.min(matches.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (matches[active]) choose(matches[active].name);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setQuery(null);
          }
        }}
      />
      <span className="branch-picker-chevron" aria-hidden="true">⌄</span>
      {open && <div className="branch-picker-popover">
        <ul id={listId} ref={list} role="listbox" aria-label="Matching branches">
          {matches.map((branch, index) => (
            <li
              id={`${listId}-${index}`}
              key={branch.name}
              role="option"
              aria-selected={branch.name === value}
              className={index === active ? "highlighted" : ""}
              title={branch.name}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setHighlight(index)}
              onClick={() => choose(branch.name)}
            >
              <span>{branch.name}</span>
              {branch.name === value && <span aria-hidden="true">✓</span>}
            </li>
          ))}
        </ul>
        {matches.length === 0 && <p role="status">No matching branches</p>}
      </div>}
    </div>
  );
}
