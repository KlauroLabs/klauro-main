fn main() {
    let command = std::env::args().nth(1).unwrap_or_else(|| "help".to_string());
    if command == "init" {
        init();
    }
    if command == "build" {
        build();
    }
}

fn init() {
    println!("init");
}

fn build() {
    println!("build");
}

fn configure(mode: &str) -> bool {
    if mode == "fast" {
        return true;
    }
    mode == "slow"
}
