use std::cell::RefCell;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use crate::crossings::Crossing;
use crate::model::{EdgeKind, IndexEdge};

pub struct Imports {
    towards: HashMap<u32, Vec<u32>>,
    closures: RefCell<HashMap<u32, HashSet<u32>>>,
}

impl Imports {
    pub fn new(files: &[String], edges: &[IndexEdge]) -> Self {
        let indexed: HashMap<&str, u32> = files.iter().enumerate().map(|(position, path)| (path.as_str(), position as u32)).collect();
        let mut towards: HashMap<u32, Vec<u32>> = HashMap::default();
        for edge in edges.iter().filter(|edge| edge.kind == EdgeKind::Imports) {
            if let (Some(from), Some(to)) = (indexed.get(edge.source.as_str()), indexed.get(edge.target.as_str())) {
                towards.entry(*from).or_default().push(*to);
            }
        }
        Imports { towards, closures: RefCell::new(HashMap::default()) }
    }

    pub fn reaches(&self, from: u32, to: u32) -> bool {
        if from == to {
            return true;
        }
        let mut closures = self.closures.borrow_mut();
        closures
            .entry(from)
            .or_insert_with(|| {
                let mut seen: HashSet<u32> = HashSet::default();
                let mut pending = vec![from];
                while let Some(file) = pending.pop() {
                    for next in self.towards.get(&file).into_iter().flatten() {
                        if seen.insert(*next) {
                            pending.push(*next);
                        }
                    }
                }
                seen
            })
            .contains(&to)
    }

    pub fn together(&self, left: u32, right: u32) -> bool {
        self.reaches(left, right) || self.reaches(right, left)
    }
}

pub struct Carrier<'a> {
    pub send: &'a Crossing,
    pub forward: &'a Crossing,
}

impl<'a> Carrier<'a> {
    pub fn carries(&self, imports: &Imports, message: &Crossing) -> bool {
        message.kind == "network"
            && message.channel != self.send.channel
            && message.from_file != self.send.to_file
            && imports.reaches(message.from_file, self.send.from_file)
            && imports.together(self.forward.to_file, message.to_file)
            && !imports.reaches(message.from_file, message.to_file)
    }
}

pub fn pairs<'a>(crossings: &[&'a Crossing], relays: impl Fn(&Crossing, &Crossing) -> bool) -> Vec<Carrier<'a>> {
    let mut by_tag: HashMap<&str, Vec<&'a Crossing>> = HashMap::default();
    for crossing in crossings.iter().copied().filter(|crossing| crossing.kind == "network") {
        by_tag.entry(crossing.channel.as_str()).or_default().push(crossing);
    }
    let mut found: Vec<Carrier<'a>> = Vec::new();
    for same in by_tag.values() {
        for send in same {
            for forward in same {
                if send.to_file == forward.from_file && send.from_file != forward.to_file && relays(send, forward) {
                    found.push(Carrier { send, forward });
                }
            }
        }
    }
    found.sort_by(|left, right| (&left.send, &left.forward).cmp(&(&right.send, &right.forward)));
    found
}
