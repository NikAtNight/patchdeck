import React from "react";
import ReactDOM from "react-dom/client";
import "./theme.css";
import App from "./App";
import { initLocalBoardStore } from "./localBoard/store";
import { initReviewStore } from "./review/reviewStore";
import { initSessionStore } from "./session";
import { initializeAppearance } from "./appearance";

const disposeAppearance = initializeAppearance();
import.meta.hot?.dispose(disposeAppearance);

void initSessionStore().then(() => Promise.all([initReviewStore(), initLocalBoardStore()])).finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
