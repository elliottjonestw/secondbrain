import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AuthGate from "./components/auth/AuthGate";
import { initI18n } from "./lib/i18n";
import "./index.css";

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
