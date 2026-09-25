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

pub fn is_test(path: &str) -> bool {
    let name = basename(path);
    let stem = name.split('.').next().unwrap_or(name);
    path.contains("test/")
        || path.contains("tests/")
        || path.contains("spec/")
        || path.contains("e2e/")
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || name.contains(".test.")
        || name.contains(".spec.")
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

pub fn is_continuous_integration(path: &str) -> bool {
    static DIRECTORIES: &[&str] =
        &[".azure/", ".buildkite/", ".circleci/", ".github/", ".gitlab/", ".woodpecker/", "ci/"];
    DIRECTORIES.iter().any(|directory| {
        path.starts_with(directory) || path.contains(&format!("/{directory}"))
    }) || path.starts_with(".gitlab-ci")
}
