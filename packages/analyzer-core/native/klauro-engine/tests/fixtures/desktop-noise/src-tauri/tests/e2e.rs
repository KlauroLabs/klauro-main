#[test]
fn runs_the_fake() {
    let program = env!("CARGO_BIN_EXE_fake-cli");
    std::process::Command::new(program).output().unwrap();
}
