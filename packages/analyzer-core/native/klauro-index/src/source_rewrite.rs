const TYPE_ARGUMENT_MARKER: &[u8] = b"typeof import(";
const QUALIFIER_MARKER: &[u8] = b"import(";

pub fn grammar_limitations(source: &mut Vec<u8>) -> u32 {
    type_argument_imports(source) + qualified_type_imports(source)
}

fn qualified_type_imports(source: &mut Vec<u8>) -> u32 {
    if find_from(source, QUALIFIER_MARKER, 0).is_none() {
        return 0;
    }
    let mut rewritten = 0;
    let mut at = 0;
    while let Some(found) = find_from(source, QUALIFIER_MARKER, at) {
        let Some(end) = closing_parenthesis(source, found + QUALIFIER_MARKER.len() - 1) else {
            break;
        };
        at = end + 1;
        if found > 0 && is_identifier_byte(source[found - 1]) {
            continue;
        }
        let mut after = end + 1;
        while after < source.len() && source[after].is_ascii_whitespace() {
            after += 1;
        }
        if after >= source.len() || source[after] != b'.' {
            continue;
        }
        for byte in &mut source[found..=after] {
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b' ';
            }
        }
        rewritten += 1;
        at = after + 1;
    }
    rewritten
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn type_argument_imports(source: &mut Vec<u8>) -> u32 {
    if find_from(source, TYPE_ARGUMENT_MARKER, 0).is_none() {
        return 0;
    }
    let mut rewritten = 0;
    let mut at = 0;
    while let Some(found) = find_from(source, TYPE_ARGUMENT_MARKER, at) {
        let Some(end) = closing_parenthesis(source, found + TYPE_ARGUMENT_MARKER.len() - 1) else {
            break;
        };
        at = end + 1;
        if !inside_type_arguments(source, found) {
            continue;
        }
        for byte in &mut source[found..=end] {
            if *byte != b'\n' && *byte != b'\r' {
                *byte = b'_';
            }
        }
        rewritten += 1;
    }
    rewritten
}

fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

fn closing_parenthesis(source: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    for (offset, byte) in source[open..].iter().enumerate() {
        let position = open + offset;
        match quote {
            Some(active) => {
                if *byte == b'\\' {
                    continue;
                }
                if *byte == active {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' | b'`' => quote = Some(*byte),
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(position);
                    }
                }
                b'\n' => return None,
                _ => {}
            },
        }
    }
    None
}

fn inside_type_arguments(source: &[u8], at: usize) -> bool {
    let mut position = at;
    while position > 0 {
        position -= 1;
        match source[position] {
            b'<' => return true,
            b'\n' | b';' | b'=' | b'{' | b'}' | b'(' | b')' => return false,
            _ => {}
        }
    }
    false
}

const SCRIPT_OPEN: &[u8] = b"<script";
const SCRIPT_CLOSE: &[u8] = b"</script";

pub fn component_script(source: &mut Vec<u8>) {
    let mut keep = vec![false; source.len()];
    let mut at = 0;
    while let Some(open) = find_from(source, SCRIPT_OPEN, at) {
        let Some(body) = source[open..].iter().position(|byte| *byte == b'>').map(|end| open + end + 1)
        else {
            break;
        };
        let end = find_from(source, SCRIPT_CLOSE, body).unwrap_or(source.len());
        keep[body..end].fill(true);
        at = end + SCRIPT_CLOSE.len();
    }
    for (position, byte) in source.iter_mut().enumerate() {
        if !keep[position] && *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
}
