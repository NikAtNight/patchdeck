import type { PrismTheme } from "prism-react-renderer";

// Colors resolve through the --syntax-* tokens in theme.css, so syntax
// highlighting follows the active color scheme automatically.
export const syntaxTheme: PrismTheme = {
  plain: { color: "var(--syntax-plain)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--syntax-comment)", fontStyle: "italic" } },
    { types: ["keyword", "operator", "important", "rule"], style: { color: "var(--syntax-keyword)" } },
    { types: ["string", "char", "inserted", "url"], style: { color: "var(--syntax-string)" } },
    { types: ["number", "boolean", "constant", "symbol", "regex"], style: { color: "var(--syntax-number)" } },
    { types: ["function", "class-name", "maybe-class-name"], style: { color: "var(--syntax-function)" } },
    { types: ["tag", "selector", "deleted", "namespace"], style: { color: "var(--syntax-tag)" } },
    { types: ["attr-name", "property", "builtin", "variable"], style: { color: "var(--syntax-attribute)" } },
    { types: ["punctuation"], style: { color: "var(--syntax-punctuation)" } },
  ],
};
