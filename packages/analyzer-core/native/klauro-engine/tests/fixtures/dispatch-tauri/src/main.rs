mod ipc;
mod klauro_analysis;

#[tauri::command]
fn ipc_call(channel: String, payload: String) -> String {
    ipc::dispatch(&channel, &payload)
}

fn main() {}
