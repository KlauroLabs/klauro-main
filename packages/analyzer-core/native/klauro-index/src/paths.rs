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
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || name.contains(".test.")
        || name.contains(".spec.")
}
