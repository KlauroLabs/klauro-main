use std::process::Command;

const ENGINE_PATH: &str = "../native/index-engine/target/release/engine-core";

fn main() {
    Command::new(ENGINE_PATH).arg("--stream").status().unwrap();
}
