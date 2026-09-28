pub fn configure(mode: &str) -> bool {
    if mode == "fast" {
        return true;
    }
    mode == "slow"
}
