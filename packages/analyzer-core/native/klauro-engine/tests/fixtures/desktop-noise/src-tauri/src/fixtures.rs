#[cfg(test)]
fn put(path: &std::path::Path, body: &str) {
    std::fs::write(path, body).unwrap();
}

#[cfg(test)]
mod tests {
    use super::put;

    #[test]
    fn writes_a_file() {
        put(std::path::Path::new("a.txt"), "x");
        put(std::path::Path::new("b.csproj"), "<Project/>");
        put(std::path::Path::new("c.json"), "[{}]");
    }
}
