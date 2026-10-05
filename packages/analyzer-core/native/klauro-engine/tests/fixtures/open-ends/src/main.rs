struct Alpha;
struct Beta;

trait Settle {
    fn reconcile(&self) -> usize;
}

impl Settle for Alpha {
    fn reconcile(&self) -> usize {
        1
    }
}

impl Settle for Beta {
    fn reconcile(&self) -> usize {
        2
    }
}

fn pick() -> Box<dyn Settle> {
    Box::new(Alpha)
}

fn wipe(path: &str) {
    std::fs::remove_dir_all(path).ok();
}

#[tauri::command]
fn ends_in_our_code() -> usize {
    let held = pick();
    held.reconcile()
}

#[tauri::command]
fn ends_in_a_library(text: String) -> usize {
    text.trim().len()
}

#[tauri::command]
fn calls_a_name_nothing_here_declares() -> usize {
    let held = pick();
    vendor_lookup(held)
}

#[tauri::command]
fn changes_and_ends_in_our_code(path: String) -> usize {
    wipe(&path);
    let held = pick();
    held.reconcile()
}

#[tauri::command]
fn runs_past_the_depth_it_is_followed() -> usize {
    hop_0()
}

fn hop_0() -> usize {
    hop_1()
}

fn hop_1() -> usize {
    hop_2()
}

fn hop_2() -> usize {
    hop_3()
}

fn hop_3() -> usize {
    hop_4()
}

fn hop_4() -> usize {
    hop_5()
}

fn hop_5() -> usize {
    hop_6()
}

fn hop_6() -> usize {
    hop_7()
}

fn hop_7() -> usize {
    hop_8()
}

fn hop_8() -> usize {
    hop_9()
}

fn hop_9() -> usize {
    hop_10()
}

fn hop_10() -> usize {
    hop_11()
}

fn hop_11() -> usize {
    hop_12()
}

fn hop_12() -> usize {
    hop_13()
}

fn hop_13() -> usize {
    hop_14()
}

fn hop_14() -> usize {
    hop_15()
}

fn hop_15() -> usize {
    hop_16()
}

fn hop_16() -> usize {
    hop_17()
}

fn hop_17() -> usize {
    17
}

fn main() {}
