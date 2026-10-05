mod engine;
fn main() { engine::hub::start(Box::new(engine::sink::AppSink(1))); engine::hub::call(); }
