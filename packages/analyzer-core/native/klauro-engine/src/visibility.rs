use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::model::IndexNode;

static PROJECT_FILES: &[&str] = &[".csproj", ".fsproj", ".vbproj"];

pub struct Visibility {
    root_of_file: Vec<Option<usize>>,
    sees: Vec<HashSet<usize>>,
}

fn directory_of(path: &str) -> &str {
    path.rfind('/').map(|at| &path[..at]).unwrap_or("")
}

fn joined(base: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for step in relative.split('/') {
        match step {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn within(root: &str, path: &str) -> bool {
    root.is_empty() || path.starts_with(&format!("{root}/"))
}

impl Visibility {
    pub fn build(files: &[String], nodes: &[IndexNode]) -> Self {
        let projects: Vec<(usize, &str)> = files
            .iter()
            .enumerate()
            .filter(|(_, path)| PROJECT_FILES.iter().any(|ending| path.ends_with(ending)))
            .map(|(at, path)| (at, path.as_str()))
            .collect();
        let mut roots: Vec<&str> = projects.iter().map(|(_, path)| directory_of(path)).collect();
        roots.sort();
        roots.dedup();
        let at_root: HashMap<&str, usize> = roots.iter().enumerate().map(|(at, root)| (*root, at)).collect();
        let mut deepest: Vec<usize> = (0..roots.len()).collect();
        deepest.sort_by_key(|at| std::cmp::Reverse(roots[*at].len()));
        let root_of_file: Vec<Option<usize>> = files
            .iter()
            .map(|path| deepest.iter().copied().find(|at| within(roots[*at], path)))
            .collect();
        let project_of_file: HashMap<u32, usize> = projects
            .iter()
            .filter_map(|(file, path)| Some((*file as u32, *at_root.get(directory_of(path))?)))
            .collect();
        let mut children: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
        for node in nodes {
            if let Some(parent) = node.parent.as_deref() {
                children.entry(parent).or_default().push(node);
            }
        }
        let mut references: Vec<HashSet<usize>> = vec![HashSet::default(); roots.len()];
        for node in nodes.iter().filter(|node| node.name == "ProjectReference") {
            let Some(from) = project_of_file.get(&node.file).copied() else { continue };
            let Some(included) = children
                .get(node.id.as_str())
                .and_then(|held| held.iter().find(|child| child.name == "Include"))
                .and_then(|child| child.type_annotation.as_deref())
            else {
                continue;
            };
            let relative = included.trim_matches('"').replace('\\', "/");
            let target = joined(roots[from], directory_of(&relative));
            if let Some(to) = at_root.get(target.as_str()).copied() {
                references[from].insert(to);
            }
        }
        let sees: Vec<HashSet<usize>> = (0..roots.len())
            .map(|from| {
                let mut seen: HashSet<usize> = HashSet::from_iter([from]);
                let mut pending = vec![from];
                while let Some(current) = pending.pop() {
                    for next in &references[current] {
                        if seen.insert(*next) {
                            pending.push(*next);
                        }
                    }
                }
                seen
            })
            .collect();
        Visibility { root_of_file, sees }
    }

    pub fn can_see(&self, from_file: u32, to_file: u32) -> bool {
        let from = self.root_of_file.get(from_file as usize).copied().flatten();
        let to = self.root_of_file.get(to_file as usize).copied().flatten();
        match (from, to) {
            (Some(from), Some(to)) => self.sees[from].contains(&to),
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_read_from_the_project_that_names_it() {
        assert_eq!(joined("src/Web", "../Components"), "src/Components");
        assert!(within("src/Web", "src/Web/Pages/Cart.cs"));
        assert!(!within("src/Web", "src/WebComponents/Cart.cs"));
    }
}
