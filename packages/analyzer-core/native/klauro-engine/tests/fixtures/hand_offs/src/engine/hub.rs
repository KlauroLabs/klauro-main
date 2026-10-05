use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

struct Job { n: i32 }
static TX: OnceLock<Mutex<Option<Sender<Job>>>> = OnceLock::new();
fn tx_slot() -> &'static Mutex<Option<Sender<Job>>> {
    TX.get_or_init(|| Mutex::new(None))
}

struct Runtime;
impl Runtime {
    fn run(&self) {
        std::process::Command::new("agent");
    }
}
struct Slot {
    rt: Runtime,
}
struct Hub {
    sink: Box<dyn super::sink::Sink>,
    slots: std::collections::HashMap<String, Slot>,
}
impl Hub {
    fn emit_all(&self) {
        self.sink.send(1);
    }
    fn handle(&mut self, job: Job) {
        self.emit_all();
        if let Some(slot) = self.slots.get_mut("a") {
            slot.rt.run();
        }
        let _ = job.n;
    }
}
fn send_job(job: Job) -> bool {
    let g = tx_slot().lock().unwrap();
    match g.as_ref() {
        Some(tx) => tx.send(job).is_ok(),
        None => false,
    }
}
pub fn call() {
    send_job(Job { n: 1 });
}
pub fn start(s: Box<dyn super::sink::Sink>) {
    let (tx, rx) = channel::<Job>();
    *tx_slot().lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        let mut hub = Hub { sink: s, slots: Default::default() };
        loop {
            match rx.recv() {
                Ok(job) => hub.handle(job),
                Err(_) => break,
            }
        }
    });
}
