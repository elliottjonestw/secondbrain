import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./components/auth/AuthGate";
import { initI18n } from "./lib/i18n";
import { applyTheme } from "./lib/theme";
import "./index.css";

// Before the first render, for the same reason the translations are: the tree
// would otherwise mount light and repaint dark a frame later. Reads
// localStorage only, so there is nothing to await.
applyTheme();

// Translations must be loaded before the first render, otherwise the tree
// mounts with raw keys and flashes. Catalogs are bundled, so this resolves
// immediately — there's no network fetch to wait on.
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AuthGate>
        <App />
      </AuthGate>
    </React.StrictMode>,
  );
});
