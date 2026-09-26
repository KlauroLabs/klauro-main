mod common;

use std::path::PathBuf;
use std::process::Command;

fn read_at(root: &std::path::Path) -> serde_json::Value {
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_klauro-engine"));
    let output = Command::new(binary)
        .arg(root)
        .env("KLAURO_EXTRACTION_CACHE", "0")
        .env("KLAURO_ENRICH", "0")
        .output()
        .expect("index runs");
    common::rehydrate_stream(&output.stdout)
}

#[test]
fn what_the_repository_ignores_is_not_read() {
    let root = std::env::temp_dir().join(format!("klauro-gitignored-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("generated")).unwrap();
    std::fs::write(root.join(".gitignore"), "generated/\nscratch.ts\n").unwrap();
    std::fs::write(root.join("src/app.ts"), "export function served() { return 1 }\n").unwrap();
    std::fs::write(root.join("generated/client.ts"), "export function generated() { return 2 }\n").unwrap();
    std::fs::write(root.join("scratch.ts"), "export function scratch() { return 3 }\n").unwrap();
    let initialised = Command::new("git").arg("init").arg("-q").current_dir(&root).status();
    if !initialised.is_ok_and(|held| held.success()) {
        return;
    }
    let index = read_at(&root);
    let paths: Vec<&str> = index["files"].as_array().unwrap().iter().filter_map(|file| file["path"].as_str()).collect();
    let _ = std::fs::remove_dir_all(&root);
    assert!(paths.contains(&"src/app.ts"), "{paths:?}");
    assert!(!paths.iter().any(|path| path.starts_with("generated/")), "{paths:?}");
    assert!(!paths.contains(&"scratch.ts"), "{paths:?}");
}
