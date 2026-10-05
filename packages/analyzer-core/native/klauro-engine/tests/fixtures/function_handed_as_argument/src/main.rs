fn main() {
    let held = std::thread::Builder::new().spawn(read_it).expect("a thread");
    held.join().ok();
    let parsed: Vec<i32> = vec!["1"].into_iter().map(parse).collect();
    let _ = parsed;
}

fn read_it() {
    stage_one();
}

fn stage_one() {}

fn parse(text: &str) -> i32 {
    text.len() as i32
}
