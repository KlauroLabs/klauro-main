mod common;

use std::process::Command;

fn index() -> serde_json::Value {
    common::read("verified")
}

#[test]
fn a_convention_is_the_shape_most_of_a_population_takes() {
    let index = index();
    let conventions = index["conformance"]["conventions"].as_array().unwrap();
    let naming = conventions
        .iter()
        .find(|convention| convention["convention"] == "test-placement")
        .expect("the repository places its tests");
    assert!(naming["population"].as_u64().unwrap() >= naming["following"].as_u64().unwrap());
    assert!(naming["following"].as_u64().unwrap() > 0, "{naming}");
}

#[test]
fn a_repository_without_history_reports_none() {
    let index = index();
    assert!(index["history"].is_null(), "a fixture holds no commits of its own");
}

#[test]
fn health_rolls_up_what_each_project_serves_and_what_reaches_it() {
    let index = index();
    let projects = index["health"]["projects"].as_array().unwrap();
    let held = projects.first().expect("the repository is one project");
    assert!(held["units"].as_u64().unwrap() > 0, "{held}");
    assert!(held["surfaces"].as_u64().unwrap() > 0, "{held}");
}

#[test]
fn the_commit_log_is_read_where_a_repository_holds_one() {
    let root = std::env::temp_dir().join(format!("klauro-history-fixture-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    let git = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .expect("git runs")
    };
    git(&["init", "--quiet"]);
    git(&["config", "user.email", "fixture@example.com"]);
    git(&["config", "user.name", "Fixture"]);
    std::fs::write(root.join("src/store.py"), "def slug(name):\n    return name.lower()\n").unwrap();
    std::fs::write(root.join("src/api.py"), "from src.store import slug\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "first"]);
    std::fs::write(root.join("src/store.py"), "def slug(name):\n    return name.strip().lower()\n")
        .unwrap();
    std::fs::write(root.join("src/api.py"), "from src.store import slug\n\n\ndef read():\n    return slug('x')\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "--quiet", "-m", "second"]);

    let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_klauro-engine"));
    let output = Command::new(binary).arg(&root).output().expect("index runs");
    assert!(output.status.success());
    let index = common::rehydrate_stream(&output.stdout);
    let history = &index["history"];
    assert_eq!(history["commits"], 2, "{history}");
    let churn = history["churn"].as_array().unwrap();
    assert!(
        churn.iter().any(|file| file["path"] == "src/store.py" && file["commits"] == 2),
        "{churn:?}"
    );
    let together = history["co_change"].as_array().unwrap();
    assert!(
        together
            .iter()
            .any(|pair| pair["commits"] == 2 && pair["path"] == "src/api.py"),
        "two files changed in both commits: {together:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
