pub trait Sink: Send + 'static {
    fn send(&self, out: i32);
}
pub struct AppSink<R: tauri::Runtime>(pub AppHandle<R>);
impl<R: tauri::Runtime> Sink for AppSink<R> {
    fn send(&self, out: i32) {
        deliver(out);
    }
}
fn deliver(_o: i32) {}
pub struct HostSink(pub i32);
impl Sink for HostSink {
    fn send(&self, out: i32) {
        broadcast(out);
    }
}
fn broadcast(_o: i32) {}
