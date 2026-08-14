import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import App from "./App";
import { initReviewStore } from "./review/reviewStore";

void initReviewStore().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
