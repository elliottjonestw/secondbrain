// Typed translation keys. Augmenting i18next's CustomTypeOptions with the
// English catalog makes `t("settings.general.language")` autocomplete and turns
// a typo into a compile error — the same posture as the rest of the repo's
// strict tsconfig. English is the source of truth; other catalogs may lag.

import "i18next";
import type en from "../locales/en/app.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "app";
    resources: { app: typeof en };
    returnNull: false;
  }
}
