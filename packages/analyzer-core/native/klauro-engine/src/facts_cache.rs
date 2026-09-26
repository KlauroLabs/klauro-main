use std::cell::Cell;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{CallContext, FileFacts, Modifiers};

thread_local! {
    static WHOLE: Cell<bool> = const { Cell::new(false) };
}

fn whole() -> bool {
    WHOLE.with(Cell::get)
}

pub fn none<T>(held: &Option<T>) -> bool {
    !whole() && held.is_none()
}

#[allow(clippy::ptr_arg)]
pub fn empty<T>(held: &Vec<T>) -> bool {
    !whole() && held.is_empty()
}

pub fn not(held: &bool) -> bool {
    !whole() && !*held
}

pub fn zero(held: &u16) -> bool {
    !whole() && *held == 0
}

pub fn default_modifiers(held: &Modifiers) -> bool {
    !whole() && held.is_default()
}

pub fn empty_context(held: &CallContext) -> bool {
    !whole() && held.is_empty()
}

pub fn hidden<T>(_: &T) -> bool {
    !whole()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    key: [u64; 2],
    file: u32,
    facts: Vec<u8>,
}

#[derive(Serialize, Deserialize, Default)]
struct Pack {
    entries: BTreeMap<String, Entry>,
}

pub struct Remembered {
    held: BTreeMap<String, Entry>,
    at: Option<PathBuf>,
    engine: [u64; 2],
}

const NOTHING_CHANGED: usize = 0;

fn folder() -> Option<PathBuf> {
    if std::env::var("KLAURO_EXTRACTION_CACHE").is_ok_and(|held| held == "0") {
        return None;
    }
    let folder = crate::jev::kept()?.parent()?.join("extraction");
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

fn engine_identity() -> [u64; 2] {
    let mut first = rustc_hash::FxHasher::default();
    let mut second = std::collections::hash_map::DefaultHasher::new();
    env!("CARGO_PKG_VERSION").hash(&mut first);
    env!("CARGO_PKG_VERSION").hash(&mut second);
    if let Ok(held) = std::env::current_exe().and_then(std::fs::metadata) {
        held.len().hash(&mut first);
        held.len().hash(&mut second);
        if let Ok(changed) = held.modified().and_then(|at| {
            at.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)
        }) {
            changed.as_nanos().hash(&mut first);
            changed.as_nanos().hash(&mut second);
        }
    }
    [first.finish(), second.finish()]
}

pub fn open(root: &Path) -> Remembered {
    let engine = engine_identity();
    let at = folder().map(|folder| {
        let mut hasher = rustc_hash::FxHasher::default();
        root.to_string_lossy().hash(&mut hasher);
        folder.join(format!("{:016x}.mp", hasher.finish()))
    });
    let held = at
        .as_ref()
        .and_then(|at| std::fs::read(at).ok())
        .and_then(|bytes| rmp_serde::from_slice::<Pack>(&bytes).ok())
        .map(|pack| pack.entries)
        .unwrap_or_default();
    Remembered { held, at, engine }
}

impl Remembered {
    pub fn key(&self, path: &str, language: Option<&str>, source: &[u8]) -> [u64; 2] {
        let mut first = rustc_hash::FxHasher::default();
        let mut second = std::collections::hash_map::DefaultHasher::new();
        for hasher in [&mut first as &mut dyn Hasher, &mut second as &mut dyn Hasher] {
            hasher.write_u64(self.engine[0]);
            hasher.write_u64(self.engine[1]);
            hasher.write(path.as_bytes());
            hasher.write_u8(0);
            hasher.write(language.unwrap_or("").as_bytes());
            hasher.write_u8(0);
            hasher.write_usize(source.len());
            hasher.write(source);
        }
        [first.finish(), second.finish()]
    }

    pub fn recall(&self, path: &str, key: [u64; 2], file: u32) -> Option<FileFacts> {
        let entry = self.held.get(path).filter(|entry| entry.key == key)?;
        let mut facts: FileFacts = rmp_serde::from_slice(&entry.facts).ok()?;
        if entry.file != file {
            facts.refile(file);
        }
        Some(facts)
    }

    pub fn entry(key: [u64; 2], file: u32, facts: &FileFacts) -> Option<Entry> {
        WHOLE.with(|whole| whole.set(true));
        let bytes = rmp_serde::to_vec(facts);
        WHOLE.with(|whole| whole.set(false));
        Some(Entry { key, file, facts: bytes.ok()? })
    }

    pub fn keep(self, fresh: Vec<(String, Entry)>, present: &rustc_hash::FxHashSet<&str>) {
        let Some(at) = self.at else { return };
        let stale = self.held.keys().filter(|path| !present.contains(path.as_str())).count();
        if fresh.len() == NOTHING_CHANGED && stale == NOTHING_CHANGED {
            return;
        }
        let mut entries = self.held;
        entries.retain(|path, _| present.contains(path.as_str()));
        entries.extend(fresh);
        let Ok(bytes) = rmp_serde::to_vec(&Pack { entries }) else { return };
        let written = at.with_extension("mp.tmp");
        if std::fs::write(&written, bytes).is_ok() {
            let _ = std::fs::rename(&written, &at);
        }
    }
}
