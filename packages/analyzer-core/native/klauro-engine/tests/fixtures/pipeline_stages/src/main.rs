mod discovery;
mod resolution;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_default();
    let listing = std::fs::read_to_string(path).unwrap_or_default();
    let files = discovery::discover(&listing);
    let graph = resolution::resolve_calls(&files);
    println!("{}", graph.len());
}
