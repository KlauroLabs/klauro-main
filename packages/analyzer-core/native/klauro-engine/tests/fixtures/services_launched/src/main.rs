use std::process::Command;

fn is_monitored(name: &str) -> bool {
    name.starts_with("@sentry")
}

fn main() {
    let tool = std::path::Path::new("tools").join("node_modules/stripe/bin/stripe");
    if !is_monitored("launcher") {
        Command::new(tool).arg("listen").status().ok();
    }
}
