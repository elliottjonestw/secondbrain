// Thin Rust layer: plugin wiring + versioned SQLite migrations only.
// All business logic lives in the TypeScript/web layer (see src/db.ts).
use tauri_plugin_sql::{Migration, MigrationKind};

const MIGRATION_V1: &str = include_str!("../migrations/001_init.sql");
const MIGRATION_V2: &str = include_str!("../migrations/002_default_lists.sql");
const MIGRATION_V3: &str = include_str!("../migrations/003_people.sql");
const MIGRATION_V4: &str = include_str!("../migrations/004_person_custom_fields.sql");
const MIGRATION_V5: &str = include_str!("../migrations/005_fts_trigram.sql");
const MIGRATION_V6: &str = include_str!("../migrations/006_note_images.sql");
const MIGRATION_V7: &str = include_str!("../migrations/007_unique_list_name.sql");

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
        Migration {
            version: 3,
            description: "people (contacts, vCard-modeled)",
            sql: MIGRATION_V3,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "global person custom-field label registry",
            sql: MIGRATION_V4,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "rebuild notes_fts with the trigram tokenizer (CJK search)",
            sql: MIGRATION_V5,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "note_images: image bytes referenced from note markdown",
            sql: MIGRATION_V6,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "collapse duplicate list names and add a case-insensitive unique index",
            sql: MIGRATION_V7,
            kind: MigrationKind::Up,
        },
    ];

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:secondbrain.db", migrations)
                .build(),
        );

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
