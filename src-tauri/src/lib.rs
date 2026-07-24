// Thin Rust layer: plugin wiring only.
//
// All business logic lives in the TypeScript/web layer (see src/db.ts), which
// now talks to a Cloudflare Worker rather than a local file. The SQLite plugin
// and its migration registry are gone with it — this is architecture rule 1
// satisfied more completely than when the rule was written, and it is what
// unblocks iOS, which `tauri-plugin-sql` never supported.

// The one exception to "plugin wiring only": IMAP needs a TCP socket, which no
// plugin provides. See src/mail.rs for why it exists and what it must keep.
mod mail;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        // Custom commands are not scoped by `http:default` — that capability
        // bounds tauri-plugin-http only — so `imap_op` enforces its own host
        // allowlist in Rust. Nothing to add to capabilities/default.json.
        .invoke_handler(tauri::generate_handler![mail::imap_op]);

    // The local dev Worker (`npm run worker:dev`, http://localhost:8787), which
    // lib/api.ts falls back to whenever VITE_API_URL is unset — i.e. in every
    // `tauri dev` run and no shipped build, since .env.production names the
    // remote Worker and Vite inlines it.
    //
    // It is a SEPARATE capability, added at runtime, rather than two more URLs
    // in capabilities/default.json, because that file ships. `plugin-http` runs
    // in Rust, outside the webview's CSP, so the capability scope is the only
    // thing bounding it: with loopback in the shipped scope, any script that
    // reaches the IPC bridge — an XSS, a compromised dependency — gets an HTTP
    // client aimed at every service on the user's machine. Nothing in a
    // packaged app needs that, so it is now structurally absent from one.
    //
    // The gate is `debug_assertions` rather than a cargo feature on purpose:
    // a feature can be named on a release build, this cannot. The cost is that
    // an E2E build (release, `--features wdio`) also has no loopback access, so
    // `VITE_API_URL=http://localhost:8787 npm run test:e2e:build` would fail at
    // the scope check rather than the network — E2E runs against the deployed
    // Worker named in .env.production, which is what it already did.
    #[cfg(debug_assertions)]
    {
        use tauri::Manager;
        builder = builder.setup(|app| {
            app.add_capability(include_str!("../dev-capabilities/localhost.json"))?;
            Ok(())
        });
    }

    // E2E only, and only when the `wdio` feature is named on the build command.
    // These expose an automation surface; they must never be in a shipped app.
    #[cfg(feature = "wdio")]
    {
        builder = builder
            .plugin(tauri_plugin_wdio::init())
            .plugin(tauri_plugin_wdio_webdriver::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
