use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use std::path::Path;

const LARGEST_FILE: u64 = 8_000_000;

static TEMPLATES: &[&str] = &[
    "haml", "slim", "erb", "ejs", "hbs", "mustache", "liquid", "twig", "jinja", "j2", "vue", "svelte", "cshtml", "html", "htm",
    "xml", "yml", "yaml", "json", "toml", "ini", "conf", "properties", "gradle", "plist", "xaml", "rake", "jbuilder", "builder",
];

#[derive(Default)]
pub struct Mentions {
    held: HashMap<String, Vec<(u32, u32, u32)>>,
    extra: Vec<String>,
}

impl Mentions {
    pub fn extra_path(&self, file: u32, indexed: usize) -> Option<&str> {
        (file as usize).checked_sub(indexed).and_then(|at| self.extra.get(at)).map(String::as_str)
    }

    pub fn of(&self, name: &str) -> &[(u32, u32, u32)] {
        self.held.get(name).map(Vec::as_slice).unwrap_or(&[])
    }
}

fn is_comment(trimmed: &str) -> bool {
    trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
        || (trimmed.starts_with('#') && !trimmed.starts_with("#[") && !trimmed.starts_with("#!") && !trimmed.starts_with("#include") && !trimmed.starts_with("#define"))
}

fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 0x80
}

fn scan_file(text: &str, file: u32, wanted: &HashSet<&str>, into: &mut HashMap<String, Vec<(u32, u32, u32)>>) {
    let mut counts: HashMap<&str, (u32, u32)> = HashMap::default();
    for (index, line) in text.lines().enumerate() {
        if is_comment(line.trim_start()) {
            continue;
        }
        let bytes = line.as_bytes();
        let mut start = 0;
        while start < bytes.len() {
            if !word_byte(bytes[start]) {
                start += 1;
                continue;
            }
            let mut end = start;
            while end < bytes.len() && word_byte(bytes[end]) {
                end += 1;
            }
            if let Some(word) = line.get(start..end)
                && wanted.contains(word)
            {
                let entry = counts.entry(word).or_insert((0, index as u32 + 1));
                entry.0 += 1;
            }
            start = end;
        }
    }
    for (word, (count, line)) in counts {
        into.entry(word.to_string()).or_default().push((file, count, line));
    }
}

fn unindexed(root: &Path, relative: &str, known: &HashSet<&str>, into: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root.join(relative)) else { return };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        let path = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
        if kind.is_dir() {
            if !name.starts_with('.') && !crate::discovery::is_skipped_directory(&name) {
                unindexed(root, &path, known, into);
            }
        } else if kind.is_file()
            && !known.contains(path.as_str())
            && name.rsplit_once('.').is_some_and(|(_, extension)| TEMPLATES.contains(&extension.to_ascii_lowercase().as_str()))
        {
            into.push(path);
        }
    }
}

pub fn scan(root: &Path, files: &[String], wanted: &HashSet<&str>) -> Mentions {
    let known: HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut extra: Vec<String> = Vec::new();
    unindexed(root, "", &known, &mut extra);
    let everything: Vec<&str> = files.iter().map(String::as_str).chain(extra.iter().map(String::as_str)).collect();
    let merged = everything
        .par_iter()
        .enumerate()
        .fold(HashMap::default, |mut into, (file, path)| {
            let absolute = crate::paths::kept_inside(root, std::path::Path::new(path)).unwrap_or_default();
            let small = std::fs::metadata(&absolute).map(|meta| meta.len() <= LARGEST_FILE).unwrap_or(false);
            if small
                && let Ok(text) = std::fs::read_to_string(&absolute)
            {
                scan_file(&text, file as u32, wanted, &mut into);
            }
            into
        })
        .reduce(HashMap::default, |mut left, right| {
            for (word, mut found) in right {
                left.entry(word).or_default().append(&mut found);
            }
            left
        });
    drop(everything);
    Mentions { held: merged, extra }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_in_a_string_or_attribute_is_counted_but_a_comment_is_not() {
        let wanted: HashSet<&str> = ["serve"].into_iter().collect();
        let mut into = HashMap::default();
        scan_file("// serve here\nlet a = \"serve\";\n#[serde(with = \"serve\")]\nobserve();\n", 3, &wanted, &mut into);
        assert_eq!(into.get("serve").unwrap(), &vec![(3, 2, 2)]);
    }
}
