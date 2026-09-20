use crate::discovery::DiscoveredFile;
use crate::language::spec_for;

const DECLARATION_CEILING: u64 = 8 << 20;
const STRUCTURE_CEILING: u64 = 64 << 10;

fn declares(language: &str) -> bool {
    crate::typescript::reads(language)
        || spec_for(language).is_some_and(|spec| {
            !spec.declares.type_kinds.is_empty()
                || !spec.declares.function_kinds.is_empty()
                || !spec.calls.kinds.is_empty()
        })
}

fn ceiling(language: Option<&str>) -> u64 {
    match language {
        Some(id) if declares(id) => DECLARATION_CEILING,
        _ => STRUCTURE_CEILING,
    }
}

pub fn readable(file: &DiscoveredFile) -> bool {
    file.bytes <= ceiling(file.language)
}
