use shared::greet;

fn main() {
    println!("{}", greet("client"));
    // The client launches the bundled client-service as a local companion process.
    let _ = std::process::Command::new("client-service").spawn();
}
