use rustc_hash::FxHashMap as HashMap;

use crate::model::IndexNode;
use crate::paths::{basename, directory_of};
use crate::subproject::scalar;

const DESCRIPTOR_NAMES: &[&str] = &["catalog-info.yaml", "catalog-info.yml"];
const UNIT_KINDS: &[&str] = &["Component", "API", "Resource"];

pub struct Descriptor {
    pub root: String,
    pub at: String,
    pub name: String,
    pub owner: Option<String>,
    pub system: Option<String>,
    pub depends_on: Vec<String>,
}

fn is_descriptor(path: &str) -> bool {
    DESCRIPTOR_NAMES.contains(&basename(path).to_ascii_lowercase().as_str())
}

fn child<'a>(
    children: &HashMap<&str, Vec<&'a IndexNode>>,
    parent: &str,
    name: &str,
) -> Option<&'a IndexNode> {
    children.get(parent)?.iter().copied().find(|node| node.name == name)
}

fn value(children: &HashMap<&str, Vec<&IndexNode>>, parent: &str, name: &str) -> Option<String> {
    scalar(child(children, parent, name)?)
}

fn read(children: &HashMap<&str, Vec<&IndexNode>>, path: &str) -> Option<Descriptor> {
    if !UNIT_KINDS.contains(&value(children, path, "kind")?.as_str()) {
        return None;
    }
    let metadata = child(children, path, "metadata")?;
    let spec = child(children, path, "spec");
    let within_spec = |name: &str| value(children, &spec?.id, name);
    let depends_on = spec
        .and_then(|spec| child(children, &spec.id, "dependsOn"))
        .map(|list| children.get(list.id.as_str()).into_iter().flatten().map(|node| node.name.clone()).collect())
        .unwrap_or_default();
    Some(Descriptor {
        root: directory_of(path).to_string(),
        at: path.to_string(),
        name: value(children, &metadata.id, "name")?,
        owner: within_spec("owner"),
        system: within_spec("system"),
        depends_on,
    })
}

pub fn all(files: &[String], children: &HashMap<&str, Vec<&IndexNode>>) -> Vec<Descriptor> {
    let mut found: Vec<Descriptor> = Vec::new();
    for path in files.iter().filter(|path| is_descriptor(path) && !directory_of(path).is_empty()) {
        let Some(descriptor) = read(children, path) else { continue };
        if found.iter().all(|held| held.root != descriptor.root) {
            found.push(descriptor);
        }
    }
    found
}
