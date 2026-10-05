#[tauri::command]
fn read_project(path: String) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tauri::command]
fn write_project(path: String) {
    std::fs::write(path, "").ok();
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_project, write_project])
        .run(tauri::generate_context!())
        .unwrap();
}
