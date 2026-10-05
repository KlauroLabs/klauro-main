const ELEMENT_FIRST: &[&str] = &[
    "all", "allMatch", "any", "anyMatch", "collect", "count", "detect", "each", "each_with_index", "each_with_object",
    "every", "filter", "filter_map", "find", "findIndex", "find_all", "find_map", "flatMap", "flat_map", "forEach",
    "for_each", "group_by", "inspect", "map", "max_by", "max_by_key", "min_by", "min_by_key", "noneMatch", "partition",
    "position", "reject", "retain", "select", "skip_while", "some", "sort_by", "sort_by_key", "sum", "take_while",
];

const ELEMENT_PASCAL: &[&str] = &[
    "All", "Any", "Count", "Exists", "Find", "FindAll", "FindIndex", "First", "FirstOrDefault", "ForEach", "GroupBy", "Last",
    "LastOrDefault", "Max", "Min", "OrderBy", "OrderByDescending", "RemoveAll", "Select", "SelectMany", "Single",
    "SingleOrDefault", "SkipWhile", "Sum", "TakeWhile", "ThenBy", "TrueForAll", "Where",
];

const ELEMENT_SECOND: &[&str] = &["fold", "inject", "reduce", "reduceRight"];

pub fn adapter_position(callee: &str) -> Option<usize> {
    let name = crate::names::leaf(callee);
    if ELEMENT_FIRST.binary_search(&name).is_ok() || ELEMENT_PASCAL.contains(&name) {
        return Some(0);
    }
    ELEMENT_SECOND.contains(&name).then_some(1)
}

const KEEPS_ITS_ELEMENTS: &[&str] = &[
    "cloned", "copied", "filter", "iter", "iter_mut", "into_iter", "peekable", "rev", "skip", "sorted", "stream", "take",
    "toList", "to_a", "to_vec", "collect", "asList", "reverse", "slice", "sort", "uniq", "compact", "drain", "values",
    "reject", "select", "sort_by", "limit", "distinct",
];

pub fn keeps_its_elements(segment: &str) -> bool {
    KEEPS_ITS_ELEMENTS.contains(&segment)
}

const COLLECTIONS: &[&str] = &[
    "Array", "ArrayList", "BTreeSet", "Collection", "Deque", "HashSet", "IEnumerable", "IList", "Iterable", "IterableIterator",
    "Iterator", "LinkedList", "List", "Queue", "ReadonlyArray", "ReadonlyList", "Sequence", "Set", "Slice", "Stack", "Vec",
    "VecDeque", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "ISet", "Option", "Optional", "Result", "Seq",
    "Stream", "Flow", "Observable", "Promise", "IQueryable", "IOrderedQueryable", "IReadOnlySet", "ImmutableList",
    "ImmutableArray", "ObservableCollection", "HashSet", "SortedSet", "Collection", "IAsyncEnumerable",
];

pub fn element_of(annotation: &str) -> Option<&str> {
    let held = annotation.trim().trim_start_matches(['&', '*']).trim_start();
    let held = held.strip_prefix("mut ").unwrap_or(held).trim_start();
    let held = held.strip_prefix("readonly ").unwrap_or(held).trim_start();
    if let Some(inner) = held.strip_suffix("[]") {
        return Some(inner.trim()).filter(|inner| !inner.is_empty());
    }
    if let Some(rest) = held.strip_prefix("[]") {
        return Some(rest.trim()).filter(|inner| !inner.is_empty());
    }
    if let Some(inner) = held.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        let inner = inner.split(';').next().unwrap_or(inner).trim();
        return Some(inner).filter(|inner| !inner.is_empty());
    }
    let open = held.find(['<', '['])?;
    let name = held[..open].trim().rsplit(['.', ':']).next().unwrap_or("");
    if !COLLECTIONS.contains(&name) {
        return None;
    }
    let close = held.rfind(['>', ']'])?;
    if close <= open + 1 {
        return None;
    }
    let inside = held[open + 1..close].trim();
    let mut depth = 0i32;
    let mut first_end = inside.len();
    for (at, letter) in inside.char_indices() {
        match letter {
            '<' | '[' | '(' => depth += 1,
            '>' | ']' | ')' => depth -= 1,
            ',' if depth == 0 => {
                first_end = at;
                break;
            }
            _ => {}
        }
    }
    Some(inside[..first_end].trim()).filter(|inner| !inner.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{adapter_position, element_of};

    #[test]
    fn a_sorted_table_can_be_searched() {
        assert_eq!(adapter_position("items.map"), Some(0));
        assert_eq!(adapter_position("fold"), Some(1));
        assert_eq!(adapter_position("unwrap"), None);
    }

    #[test]
    fn the_element_of_a_collection_is_its_first_type_argument() {
        assert_eq!(element_of("Vec<Alias>"), Some("Alias"));
        assert_eq!(element_of("&[&dyn Flag]"), Some("&dyn Flag"));
        assert_eq!(element_of("Option<Box<Foo>>"), Some("Box<Foo>"));
        assert_eq!(element_of("string[]"), Some("string"));
        assert_eq!(element_of("[]*Cart"), Some("*Cart"));
        assert_eq!(element_of("List<Item>"), Some("Item"));
        assert_eq!(element_of("Map<string, Foo>"), None);
        assert_eq!(element_of("Foo"), None);
    }

    #[test]
    fn the_adapter_table_is_sorted() {
        assert!(super::ELEMENT_FIRST.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
