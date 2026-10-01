import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Native window (overlay title bar with traffic lights) vs plain browser; checked before devMock fakes __TAURI_INTERNALS__.
if ("__TAURI_INTERNALS__" in window) document.documentElement.dataset.native = "";

// Plain-browser preview (vite dev without Tauri): mock `invoke` with sample data so the UI is reviewable.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  import("./lib/devMock").then(render);
} else {
  render();
}
