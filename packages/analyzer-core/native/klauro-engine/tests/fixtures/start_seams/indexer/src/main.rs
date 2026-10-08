fn main() {
    let root = std::env::args().nth(1).unwrap_or_default();
    println!("indexed {root}");
}
