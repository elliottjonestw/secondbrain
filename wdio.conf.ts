// E2E against the REAL Tauri app: real tauri-plugin-sql, real secondbrain.db.
//
// This exists to cover what the browser dev backend (src/lib/browserDb.ts)
// structurally cannot: the plugin's JSON bridge, the native webview's quirks,
// and anything that only exists once the app is packaged.
//
// The app must be built with the `wdio` feature first — run
// `npm run test:e2e:build` once before `npm run test:e2e`. The build is kept
// separate so iterating on specs doesn't trigger a multi-minute rebuild every
// run; rebuild only when Rust/Tauri code changes. Without the feature the
// embedded WebDriver server isn't compiled in and the session fails to attach.

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",
  specs: ["./e2e/**/*.spec.ts"],
  maxInstances: 1, // one app, one real database — never run these in parallel
  services: ["@wdio/tauri-service"],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        // The executable INSIDE the bundle — spawning the `.app` directory
        // itself fails with EACCES. Note the binary keeps its crate name.
        application: "./src-tauri/target/release/bundle/macos/Second Brain.app/Contents/MacOS/second-brain",
      },
    } as WebdriverIO.Capabilities,
  ],
  reporters: ["spec"],
  logLevel: "warn",
  mochaOpts: {
    ui: "bdd",
    // The first launch runs migrations against a real DB file.
    timeout: 120_000,
  },
};
