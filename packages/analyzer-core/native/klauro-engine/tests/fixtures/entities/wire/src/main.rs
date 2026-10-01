use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: u32,
    pub text: String,
}

#[derive(Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    pub pinned: bool,
}

pub struct Scratch {
    pub hits: u32,
    pub misses: u32,
}

#[tauri::command]
fn save_note(draft: Draft) -> Result<Note, String> {
    Ok(Note { id: 1, text: draft.text })
}

#[tauri::command]
fn list_notes() -> Vec<Note> {
    Vec::new()
}

fn tally(scratch: &Scratch) -> u32 {
    scratch.hits + scratch.misses
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_note, list_notes])
        .run(tauri::generate_context!())
        .unwrap();
}
