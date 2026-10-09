pub fn resolve_calls(files: &[String]) -> Vec<(String, Vec<String>)> {
    files.iter().map(|file| (file.clone(), Vec::new())).collect()
}
