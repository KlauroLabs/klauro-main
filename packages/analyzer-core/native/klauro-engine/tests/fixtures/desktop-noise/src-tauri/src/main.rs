mod note_store;
mod fixtures;

#[tauri::command]
fn read_note(id: String) -> String {
    note_store::load(&id)
}

#[tauri::command]
fn write_note(id: String, body: String) {
    note_store::save(&id, &body);
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_note, write_note])
        .run(tauri::generate_context!())
        .expect("run");
}
