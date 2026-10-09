pub fn discover(listing: &str) -> Vec<String> {
    listing.lines().filter(|line| !line.is_empty()).map(str::to_string).collect()
}
