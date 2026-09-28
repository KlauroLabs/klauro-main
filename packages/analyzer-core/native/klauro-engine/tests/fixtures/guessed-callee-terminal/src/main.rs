struct Store;

impl Store {
    fn do_write(&self, path: &str) -> std::io::Result<()> {
        std::fs::remove_dir_all(path)
    }
}

#[tauri::command]
fn ipc_call(channel: String, payload: String) -> String {
    dispatch(&channel, &payload)
}

fn dispatch(channel: &str, payload: &str) -> String {
    let items = vec![Store, Store];
    match channel {
        "archive:delete" => {
            let _ = items[0].do_write(payload);
            "ok".to_string()
        }
        _ => String::new(),
    }
}

fn main() {}
