// Thin Rust layer: plugin wiring + versioned SQLite migrations only.
// All business logic lives in the TypeScript/web layer (see src/db.ts).
use tauri_plugin_sql::{Migration, MigrationKind};

const MIGRATION_V1: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_V2: &str = include_str!("../migrations/002_default_lists.sql");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema: events, reminders, todos, notes, tags, links",
            sql: MIGRATION_V1,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "seed default lists Personal and Work, drop Inbox",
            sql: MIGRATION_V2,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:secondbrain.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
