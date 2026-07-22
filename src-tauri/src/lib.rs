// Thin Rust layer: plugin wiring only.
//
// All business logic lives in the TypeScript/web layer (see src/db.ts), which
// now talks to a Cloudflare Worker rather than a local file. The SQLite plugin
// and its migration registry are gone with it — this is architecture rule 1
// satisfied more completely than when the rule was written, and it is what
// unblocks iOS, which `tauri-plugin-sql` never supported.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init());

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
