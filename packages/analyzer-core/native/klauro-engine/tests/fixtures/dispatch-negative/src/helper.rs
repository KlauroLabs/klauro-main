pub fn configure(mode: &str) -> bool {
    if mode == "fast" {
        return true;
    }
    mode == "slow"
}

pub fn normalize(path: &str) -> String {
    if path == "." {
        return String::new();
    }
    match path {
        ".." => "up".to_string(),
        _ => path.to_string(),
    }
}
