use rustc_hash::FxHashSet as HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rayon::prelude::*;
use regex::RegexSet;
use serde::Serialize;

use crate::language_hints;
use crate::language_tables::{
    LANGUAGE_BY_EXTENSION, LANGUAGE_BY_MANIFEST, MANIFEST_EXTENSIONS, MANIFEST_NAMES, MANIFEST_PATTERNS,
    SKIPPED_DIRECTORIES, SOURCE_EXTENSIONS,
};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Source,
    Manifest,
    Config,
    Script,
}

#[derive(Debug, Serialize)]
pub struct DiscoveredFile {
    pub path: String,
    pub kind: FileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<&'static str>,
    #[serde(skip)]
    pub bytes: u64,
    #[serde(skip)]
    pub absolute: PathBuf,
}

#[derive(Debug, Serialize)]
pub struct Discovery {
    pub files: Vec<DiscoveredFile>,
    pub skipped_directories: Vec<String>,
    pub nested_repositories: Vec<String>,
}

static NOTEBOOK_EXTENSIONS: &[&str] = &["ipynb"];

static CONFIG_EXTENSIONS: &[&str] = &[
    "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
    "properties", "env", "editorconfig",
];

static LOCK_FILES: &[&str] = &[
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "gemfile.lock",
    "cargo.lock", "composer.lock", "go.sum", "flake.lock", "package.resolved",
];

static MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "tiff", "mp3", "mp4",
    "wav", "mov", "avi", "webm", "ogg", "flac", "pdf", "zip", "tar", "gz", "bz2",
    "xz", "7z", "rar", "woff", "woff2", "ttf", "otf", "eot", "wasm", "so", "dylib",
    "dll", "exe", "bin", "dat", "db", "sqlite",
];

fn set(values: &[&'static str]) -> HashSet<&'static str> {
    values.iter().copied().collect()
}

struct Tables {
    source_extensions: HashSet<&'static str>,
    manifest_names: HashSet<&'static str>,
    manifest_extensions: HashSet<&'static str>,
    manifest_patterns: RegexSet,
    skipped: HashSet<&'static str>,
    notebooks: HashSet<&'static str>,
    config_extensions: HashSet<&'static str>,
    lock_files: HashSet<&'static str>,
    media_extensions: HashSet<&'static str>,
}

fn tables() -> &'static Tables {
    static TABLES: OnceLock<Tables> = OnceLock::new();
    TABLES.get_or_init(|| Tables {
        source_extensions: set(SOURCE_EXTENSIONS),
        manifest_names: set(MANIFEST_NAMES),
        manifest_extensions: set(MANIFEST_EXTENSIONS),
        manifest_patterns: RegexSet::new(MANIFEST_PATTERNS.iter().map(|p| format!("(?i){p}")))
            .expect("generated manifest patterns are valid"),
        skipped: set(SKIPPED_DIRECTORIES),
        notebooks: set(NOTEBOOK_EXTENSIONS),
        config_extensions: set(CONFIG_EXTENSIONS),
        lock_files: set(LOCK_FILES),
        media_extensions: set(MEDIA_EXTENSIONS),
    })
}

fn extension_of(basename_lower: &str) -> &str {
    match basename_lower.rfind('.') {
        Some(dot) => &basename_lower[dot + 1..],
        None => "",
    }
}

pub fn is_skipped_directory(name: &str) -> bool {
    if tables().skipped.contains(name) {
        return true;
    }
    if name.starts_with(".klauro") {
        return true;
    }
    is_build_artifact_directory(name)
}

fn is_build_artifact_directory(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == "dist" {
        return true;
    }
    match lower.strip_prefix("dist") {
        Some(rest) => {
            let mut chars = rest.chars();
            matches!(chars.next(), Some('-') | Some('_') | Some('.')) && chars.next().is_some()
        }
        None => false,
    }
}

fn starts_with_shebang(path: &Path) -> bool {
    let mut buffer = [0u8; 2];
    match File::open(path).and_then(|mut file| file.read(&mut buffer)) {
        Ok(2) => buffer == [b'#', b'!'],
        _ => false,
    }
}

pub fn classify(basename: &str, absolute: &Path) -> Option<FileKind> {
    let tables = tables();
    let lower = basename.to_ascii_lowercase();
    let extension = extension_of(&lower);

    if tables.manifest_names.contains(lower.as_str())
        || tables.manifest_patterns.is_match(&lower)
        || (!extension.is_empty() && tables.manifest_extensions.contains(extension))
    {
        return Some(FileKind::Manifest);
    }
    if crate::coverage::is_report(&lower) {
        return Some(FileKind::Config);
    }
    if !extension.is_empty() && tables.source_extensions.contains(extension) {
        return Some(FileKind::Source);
    }
    if let Some(hint) = language_hints::for_name(&lower).or_else(|| language_hints::for_extension(extension)) {
        return Some(hint.kind);
    }
    if tables.notebooks.contains(extension) {
        return Some(FileKind::Source);
    }
    if tables.media_extensions.contains(extension) {
        return None;
    }
    if tables.lock_files.contains(lower.as_str()) {
        return None;
    }
    if tables.config_extensions.contains(extension) {
        return Some(FileKind::Config);
    }
    if let Some(stripped) = lower.strip_prefix('.')
        && tables.config_extensions.contains(stripped)
    {
        return Some(FileKind::Config);
    }
    if lower == ".env" || lower.starts_with(".env.") {
        return Some(FileKind::Config);
    }
    if extension.is_empty() && starts_with_shebang(absolute) {
        return Some(FileKind::Script);
    }
    None
}

pub fn interpreter_of(path: &Path) -> Option<&'static str> {
    let mut buffer = [0u8; 128];
    let read = File::open(path)
        .and_then(|mut file| file.read(&mut buffer))
        .ok()?;
    let line = std::str::from_utf8(&buffer[..read]).ok()?.lines().next()?;
    if !line.starts_with("#!") {
        return None;
    }
    let interpreter = line
        .rsplit(['/', ' '])
        .find(|part| !part.is_empty() && *part != "-S")?;
    language_hints::for_shebang(interpreter)?.language
}

pub fn language_of(basename: &str) -> Option<&'static str> {
    let lower = basename.to_ascii_lowercase();
    if let Some((_, language)) = LANGUAGE_BY_MANIFEST.iter().find(|(name, _)| *name == lower) {
        return Some(language);
    }
    let extension = extension_of(&lower);
    let by_extension = LANGUAGE_BY_EXTENSION
        .binary_search_by(|(key, _)| (*key).cmp(extension))
        .ok()
        .map(|found| LANGUAGE_BY_EXTENSION[found].1);
    by_extension.or_else(|| {
        language_hints::for_name(&lower)
            .or_else(|| language_hints::for_extension(extension))
            .and_then(|hint| hint.language)
    })
}

struct Level {
    files: Vec<DiscoveredFile>,
    directories: Vec<(PathBuf, String)>,
    skipped: Vec<String>,
    nested: Vec<String>,
}

fn is_built_output(absolute: &Path) -> bool {
    if let Ok(held) = std::fs::read(absolute.join("CACHEDIR.TAG"))
        && held.starts_with(b"Signature: 8a477f597d28d172789f06886806bc55")
    {
        return true;
    }
    absolute.join(".rustc_info.json").is_file()
}

fn read_directory(absolute: &Path, relative: &str) -> Level {
    let mut level = Level {
        files: Vec::new(),
        directories: Vec::new(),
        skipped: Vec::new(),
        nested: Vec::new(),
    };
    let Ok(entries) = std::fs::read_dir(absolute) else {
        return level;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let child_relative = if relative.is_empty() {
            name.to_string()
        } else {
            format!("{relative}/{name}")
        };
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if name == ".git" && !relative.is_empty() {
                level.nested.push(relative.to_string());
            }
            if is_skipped_directory(name) || is_built_output(&entry.path()) {
                level.skipped.push(child_relative);
                continue;
            }
            level.directories.push((entry.path(), child_relative));
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let path = entry.path();
        if let Some(file_kind) = classify(name, &path) {
            level.files.push(DiscoveredFile {
                path: child_relative,
                kind: file_kind,
                language: match file_kind {
                    FileKind::Script => interpreter_of(&path),
                    _ => language_of(name),
                },
                bytes: entry.metadata().map(|meta| meta.len()).unwrap_or_default(),
                absolute: path,
            });
        }
    }
    level
}

fn ignored_by_git(root: &Path) -> rustc_hash::FxHashSet<String> {
    if std::env::var("KLAURO_RESPECT_GITIGNORE").is_ok_and(|held| held == "0") {
        return rustc_hash::FxHashSet::default();
    }
    let Ok(listed) = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .stderr(std::process::Stdio::null())
        .output()
    else {
        return rustc_hash::FxHashSet::default();
    };
    if !listed.status.success() {
        return rustc_hash::FxHashSet::default();
    }
    String::from_utf8_lossy(&listed.stdout)
        .split('\0')
        .filter(|held| !held.is_empty())
        .map(str::to_string)
        .collect()
}

fn git_ignores(ignored: &rustc_hash::FxHashSet<String>, relative: &str) -> bool {
    !ignored.is_empty()
        && (ignored.contains(relative)
            || ignored.contains(&format!("{relative}/"))
            || relative.match_indices('/').any(|(at, _)| ignored.contains(&relative[..=at])))
}

pub fn discover(root: &Path) -> Discovery {
    let mut files = Vec::new();
    let mut skipped_directories = Vec::new();
    let mut nested_repositories = Vec::new();
    let mut frontier = vec![(root.to_path_buf(), String::new())];
    let ignored = ignored_by_git(root);

    while !frontier.is_empty() {
        let levels: Vec<Level> = frontier
            .par_iter()
            .map(|(absolute, relative)| read_directory(absolute, relative))
            .collect();
        frontier = Vec::new();
        for level in levels {
            files.extend(level.files);
            skipped_directories.extend(level.skipped);
            nested_repositories.extend(level.nested);
            for (absolute, relative) in level.directories {
                match git_ignores(&ignored, &relative) {
                    true => skipped_directories.push(relative),
                    false => frontier.push((absolute, relative)),
                }
            }
        }
    }
    if !ignored.is_empty() {
        files.retain(|file| !git_ignores(&ignored, &file.path));
    }

    nested_repositories.sort();
    nested_repositories.dedup();
    if !nested_repositories.is_empty() {
        files.retain(|file| {
            !nested_repositories
                .iter()
                .any(|repository| file.path.starts_with(&format!("{repository}/")))
        });
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));
    skipped_directories.sort();
    Discovery { files, skipped_directories, nested_repositories }
}
