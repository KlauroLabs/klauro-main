use std::io::Write;
use std::sync::Mutex;

static WRITING: Mutex<()> = Mutex::new(());

fn folder() -> Option<std::path::PathBuf> {
    let folder = match std::env::var("KLAURO_DATASET_PATH").ok().filter(|held| !held.is_empty()) {
        Some(held) => std::path::PathBuf::from(held),
        None => crate::jev::kept()?.parent()?.join("dataset"),
    };
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

pub(crate) fn record(kind: &str, held: serde_json::Value) {
    if std::env::var("KLAURO_DATASET").is_ok_and(|held| held == "0") || !crate::author::asked() {
        return;
    }
    let Some(folder) = folder() else { return };
    let Ok(line) = serde_json::to_string(&held) else { return };
    let _guard = WRITING.lock();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(folder.join(format!("{kind}.jsonl"))) {
        let _ = writeln!(file, "{line}");
    }
}
