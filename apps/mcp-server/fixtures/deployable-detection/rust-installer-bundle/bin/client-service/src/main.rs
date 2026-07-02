use shared::greet;

fn main() {
    println!("{}", greet("client-service"));
    // Local IPC server backing the client UI; not independently shipped.
}
