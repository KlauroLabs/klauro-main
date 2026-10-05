pub struct Leaf {
    pub path: Vec<String>,
    pub alias: Option<String>,
    pub glob: bool,
}

pub struct Use {
    pub public: bool,
    pub leaves: Vec<Leaf>,
}

struct Reader<'t> {
    text: &'t [u8],
    at: usize,
}

impl<'t> Reader<'t> {
    fn blank(&mut self) {
        while self.at < self.text.len() && (self.text[self.at] as char).is_whitespace() {
            self.at += 1;
        }
    }

    fn eat(&mut self, expected: &str) -> bool {
        self.blank();
        if self.text[self.at..].starts_with(expected.as_bytes()) {
            self.at += expected.len();
            return true;
        }
        false
    }

    fn next_is(&mut self, expected: &str) -> bool {
        self.blank();
        self.text[self.at..].starts_with(expected.as_bytes())
    }

    fn word(&mut self) -> Option<String> {
        self.blank();
        let start = self.at;
        while self.at < self.text.len() {
            let letter = self.text[self.at] as char;
            if letter.is_alphanumeric() || letter == '_' || letter == '$' || self.text[self.at] >= 0x80 {
                self.at += 1;
            } else {
                break;
            }
        }
        (self.at > start).then(|| String::from_utf8_lossy(&self.text[start..self.at]).into_owned())
    }

    fn keyword(&mut self, expected: &str) -> bool {
        let saved = self.at;
        match self.word() {
            Some(found) if found == expected => true,
            _ => {
                self.at = saved;
                false
            }
        }
    }

    fn skip_parenthesised(&mut self) {
        if !self.eat("(") {
            return;
        }
        let mut depth = 1;
        while self.at < self.text.len() && depth > 0 {
            match self.text[self.at] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            self.at += 1;
        }
    }

    fn tree(&mut self, prefix: &[String], found: &mut Vec<Leaf>) -> bool {
        let mut path: Vec<String> = prefix.to_vec();
        self.eat("::");
        loop {
            if self.eat("{") {
                loop {
                    self.blank();
                    if self.eat("}") {
                        return true;
                    }
                    if !self.tree(&path, found) {
                        return false;
                    }
                    self.eat(",");
                }
            }
            if self.eat("*") {
                found.push(Leaf { path, alias: None, glob: true });
                return true;
            }
            let Some(segment) = self.word() else { return false };
            if segment == "self" && path.len() == prefix.len() && !self.next_is("::") {
                found.push(Leaf { path: prefix.to_vec(), alias: self.alias(), glob: false });
                return true;
            }
            path.push(segment);
            if self.eat("::") {
                continue;
            }
            let alias = self.alias();
            found.push(Leaf { path, alias, glob: false });
            return true;
        }
    }

    fn alias(&mut self) -> Option<String> {
        if !self.keyword("as") {
            return None;
        }
        self.word()
    }
}

pub fn parse(text: &str) -> Option<Use> {
    let mut reader = Reader { text: text.as_bytes(), at: 0 };
    let mut public = false;
    if reader.keyword("pub") {
        public = true;
        reader.skip_parenthesised();
    }
    if !reader.keyword("use") {
        return None;
    }
    let mut leaves = Vec::new();
    if !reader.tree(&[], &mut leaves) {
        return None;
    }
    Some(Use { public, leaves })
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn spelled(text: &str) -> Vec<String> {
        parse(text)
            .unwrap()
            .leaves
            .iter()
            .map(|leaf| {
                let mut shown = leaf.path.join("::");
                if leaf.glob {
                    shown.push_str("::*");
                }
                if let Some(alias) = &leaf.alias {
                    shown.push_str(&format!(" as {alias}"));
                }
                shown
            })
            .collect()
    }

    #[test]
    fn a_single_path_is_one_leaf() {
        assert_eq!(spelled("use grep_searcher::SearcherBuilder;"), ["grep_searcher::SearcherBuilder"]);
    }

    #[test]
    fn nested_groups_expand_to_every_leaf() {
        assert_eq!(
            spelled("pub use crate::{\n    line_buffer::{LineBuffer, LineBufferBuilder},\n    searcher::Searcher,\n};"),
            ["crate::line_buffer::LineBuffer", "crate::line_buffer::LineBufferBuilder", "crate::searcher::Searcher"]
        );
    }

    #[test]
    fn self_glob_and_alias_are_read() {
        assert_eq!(
            spelled("use std::io::{self, Read as R, prelude::*};"),
            ["std::io", "std::io::Read as R", "std::io::prelude::*"]
        );
    }

    #[test]
    fn visibility_is_noted() {
        assert!(parse("pub(crate) use a::b;").unwrap().public);
        assert!(!parse("use a::b;").unwrap().public);
    }
}
