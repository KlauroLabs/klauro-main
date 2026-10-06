pub fn names_the_file(specifier: &str, path: &str) -> bool {
    let Some((_, tail)) = specifier.split_once('\\') else { return false };
    let wanted = tail.replace('\\', "/").to_ascii_lowercase();
    let held = path.rsplit_once('.').map_or(path, |(stem, _)| stem).to_ascii_lowercase();
    held == wanted || held.ends_with(&format!("/{wanted}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_namespaced_class_names_the_file_under_its_root() {
        assert!(names_the_file("App\\Domains\\Api\\VaultController", "app/Domains/Api/VaultController.php"));
        assert!(!names_the_file("App\\Domains\\Api\\VaultController", "app/Domains/Web/VaultController.php"));
    }

    #[test]
    fn a_name_without_a_namespace_names_no_file() {
        assert!(!names_the_file("VaultController", "app/VaultController.php"));
    }
}
