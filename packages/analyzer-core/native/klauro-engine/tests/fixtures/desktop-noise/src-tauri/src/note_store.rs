use std::fs;

pub fn load(id: &str) -> String {
    fs::read_to_string(format!("notes/{id}.txt")).unwrap_or_default()
}

pub fn save(id: &str, body: &str) {
    fs::write(format!("notes/{id}.txt"), body).ok();
}
