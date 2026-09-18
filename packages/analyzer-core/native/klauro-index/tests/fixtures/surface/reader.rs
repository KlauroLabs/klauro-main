use std::fs;

pub fn load(path: &str) -> String {
    let _ = fs::metadata(path);
    fs::read_to_string(path).unwrap()
}

pub fn label(name: &str) -> String {
    name.to_string()
}
