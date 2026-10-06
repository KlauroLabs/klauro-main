pub fn directory_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(at) => &path[..at],
        None => "",
    }
}

pub fn display_name(root: &str) -> String {
    match root.rsplit('/').next() {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => "root".to_string(),
    }
}

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn file_of(id: &str) -> &str {
    match id.find(':') {
        Some(at) => &id[..at],
        None => id,
    }
}

pub fn contains(root: &str, path: &str) -> bool {
    if root.is_empty() {
        return true;
    }
    path == root
        || (path.len() > root.len()
            && path.as_bytes()[root.len()] == b'/'
            && path.starts_with(root))
}

pub fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

pub fn join(root: &str, relative: &str) -> String {
    if relative.starts_with('/') || root.is_empty() {
        normalize(relative.trim_start_matches('/'))
    } else {
        normalize(&format!("{root}/{relative}"))
    }
}

static TEST_DIRECTORIES: &[&str] =
    &["__mocks__", "__tests__", "e2e", "mocks", "spec", "specs", "test", "testing", "tests"];

fn in_a_test_directory(path: &str) -> bool {
    let Some((directories, _)) = path.rsplit_once('/') else { return false };
    directories.split('/').any(|directory| {
        TEST_DIRECTORIES.contains(&directory.to_ascii_lowercase().as_str())
            || directory.ends_with("Tests")
            || directory.ends_with(".tests")
            || directory.ends_with(".test")
            || directory.ends_with("Test") && directory.len() > 4
    })
}

fn marked_as_a_test_file(path: &str) -> bool {
    let name = basename(path);
    name.contains(".test.") || name.contains(".spec.") || name.contains(".integration.")
}

fn named_like_a_test_by_convention_alone(path: &str) -> bool {
    let name = basename(path);
    let stem = name.split('.').next().unwrap_or(name);
    stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || stem.ends_with("Tests")
        || (stem.ends_with("Test") && stem.len() > 4)
}

pub fn is_test(path: &str) -> bool {
    in_a_test_directory(path) || marked_as_a_test_file(path) || named_like_a_test_by_convention_alone(path)
}

pub fn is_unambiguously_test(path: &str) -> bool {
    in_a_test_directory(path) || marked_as_a_test_file(path)
}

static NOT_PROGRAM_CODE: &[&str] = &["css", "scss", "sass", "less", "html", "htm", "json", "yaml", "yml", "toml", "xml", "md", "svg", "editorconfig", "ini", "cfg", "conf", "env", "properties", "gitignore", "gitattributes", "lock", "csv", "txt"];

pub fn is_schema_migration(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let name = basename(&lowered);
    let stamped = name.chars().take_while(|letter| letter.is_ascii_digit()).count() >= 4;
    (lowered.contains("/migrations/") || lowered.contains("/migrate/") || lowered.starts_with("migrations/")) && stamped
}

pub fn is_hand_written_code(path: &str) -> bool {
    let extension = basename(path).rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
    !is_test(path) && !is_schema_migration(path) && !NOT_PROGRAM_CODE.contains(&extension.as_str())
}

pub fn is_not_shipped(path: &str) -> bool {
    static DIRECTORIES: &[&str] = &[
        "bench/",
        "benches/",
        "benchmarks/",
        "examples/",
        "example/",
        "fixtures/",
        "testdata/",
        "__tests__/",
        "__mocks__/",
        "mocks/",
    ];
    DIRECTORIES.iter().any(|directory| {
        path.starts_with(directory) || path.contains(&format!("/{directory}"))
    })
}

pub fn role_named_by_path(path: &str) -> Option<&'static str> {
    let segments: Vec<&str> = path.split('/').collect();
    let directories = &segments[..segments.len().saturating_sub(1)];
    let inside = |names: &[&str]| directories.iter().any(|segment| names.contains(segment));
    if inside(&["bench", "benches", "benchmarks"]) {
        return Some("benchmark");
    }
    if inside(&["examples", "example"]) {
        return Some("example");
    }
    if inside(&["fixtures", "testdata", "__tests__", "__mocks__", "mocks"]) {
        return Some("test-support");
    }
    if inside(&["scripts"]) {
        return Some("tooling");
    }
    if is_benchmark_named(path) {
        return Some("benchmark");
    }
    None
}

pub fn is_cargo_build_script(path: &str) -> bool {
    basename(path) == "build.rs"
}

pub fn is_cargo_binary_entry(path: &str) -> bool {
    path == "src/main.rs" || path.ends_with("/src/main.rs") || path.starts_with("src/bin/") || path.contains("/src/bin/")
}

pub fn is_shipping_evidence_mappable(path: &str) -> bool {
    let extension = basename(path).rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
    matches!(extension.as_str(), "cjs" | "js" | "jsx" | "mjs" | "mts" | "ts" | "tsx" | "rs")
}

fn stem_words(stem: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut previous_was_lower_or_digit = false;
    for letter in stem.chars() {
        if letter.is_alphanumeric() {
            if letter.is_uppercase() && previous_was_lower_or_digit && !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            current.push(letter.to_ascii_lowercase());
            previous_was_lower_or_digit = letter.is_lowercase() || letter.is_numeric();
        } else {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_was_lower_or_digit = false;
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

pub fn is_benchmark_named(path: &str) -> bool {
    let name = basename(path);
    let stem = name.split('.').next().unwrap_or(name);
    stem_words(stem).iter().any(|word| word == "bench" || word == "benchmark")
}

pub fn is_continuous_integration(path: &str) -> bool {
    static DIRECTORIES: &[&str] =
        &[".azure/", ".buildkite/", ".circleci/", ".github/", ".gitlab/", ".woodpecker/", "ci/"];
    DIRECTORIES.iter().any(|directory| {
        path.starts_with(directory) || path.contains(&format!("/{directory}"))
    }) || path.starts_with(".gitlab-ci")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capitalised_tests_directory_holds_tests() {
        assert!(is_test("Tests/AppTests/RoutesTests.swift"));
        assert!(is_test("src/Jellyfin.Api.Tests/Controllers/ItemsTests.cs"));
    }

    #[test]
    fn a_module_merely_named_for_testing_in_its_name_holds_shipped_code() {
        assert!(!is_test("dropwizard-e2e/src/main/java/App.java"));
        assert!(!is_test("src/latest/handler.ts"));
    }

    #[test]
    fn mocks_and_testing_support_directories_hold_tests() {
        assert!(is_test("src/mocks/handlers.ts"));
        assert!(is_test("app/javascript/testing/api.ts"));
    }
}
