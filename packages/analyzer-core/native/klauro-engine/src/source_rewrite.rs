const TYPE_ARGUMENT_MARKER: &[u8] = b"typeof import(";
const QUALIFIER_MARKER: &[u8] = b"import(";

pub fn grammar_limitations(source: &mut [u8]) -> u32 {
    type_argument_imports(source) + qualified_type_imports(source)
}

fn qualified_type_imports(source: &mut [u8]) -> u32 {
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

fn type_argument_imports(source: &mut [u8]) -> u32 {
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

pub fn component_script(source: &mut [u8]) {
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

pub struct Component {
    pub source: Vec<u8>,
    pub named: String,
    pub routes: Vec<String>,
}

static KEEPS_CODE: &[&str] = &["@code", "@functions"];

fn directive<'l>(line: &'l str, named: &str) -> Option<&'l str> {
    let rest = line.trim_start().strip_prefix(named)?;
    rest.starts_with(char::is_whitespace).then(|| rest.trim())
}

pub fn razor_component(source: &[u8], path: &str) -> Option<Component> {
    let text = std::str::from_utf8(source).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let stem = path.rsplit('/').next()?.split('.').next()?;
    let named: String = stem.chars().filter(|letter| letter.is_alphanumeric() || *letter == '_').collect();
    if named.is_empty() {
        return None;
    }
    let mut routes = Vec::new();
    let mut attributes: Vec<String> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    let mut depth: Option<i64> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(held) = depth {
            let mut balance = held;
            let mut cut = line.len();
            for (at, letter) in line.char_indices() {
                match letter {
                    '{' => balance += 1,
                    '}' => {
                        balance -= 1;
                        if balance == 0 {
                            cut = at;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            if balance == 0 {
                kept.push(format!("{}{}", &line[..cut], " ".repeat(line.len() - cut)));
                depth = None;
            } else {
                kept.push(line.to_string());
                depth = Some(balance);
            }
            continue;
        }
        if let Some(route) = directive(line, "@page") {
            routes.push(route.trim_matches('"').to_string());
            kept.push(String::new());
            continue;
        }
        if let Some(attributed) = directive(line, "@attribute") {
            attributes.push(attributed.to_string());
            kept.push(String::new());
            continue;
        }
        if let Some(injected) = directive(line, "@inject") {
            let mut words = injected.split_whitespace();
            match (words.next(), words.next()) {
                (Some(typed), Some(name)) => kept.push(format!("{typed} {name};")),
                _ => kept.push(String::new()),
            }
            continue;
        }
        if let Some(opened) = KEEPS_CODE.iter().find_map(|keeps| {
            let rest = line.trim_start().strip_prefix(keeps)?;
            let brace = rest.find('{')?;
            rest[..brace].trim().is_empty().then_some(rest[brace + 1..].to_string())
        }) {
            let balance = 1 + opened.matches('{').count() as i64 - opened.matches('}').count() as i64;
            match balance <= 0 {
                true => kept.push(String::new()),
                false => {
                    kept.push(opened);
                    depth = Some(balance);
                }
            }
            continue;
        }
        kept.push(String::new());
    }
    let mut rewritten = format!("{} class {named} : ComponentBase {{ ", attributes.join(" "));
    rewritten.push_str(&kept.join("\n"));
    rewritten.push_str("\n}\n");
    Some(Component { source: rewritten.into_bytes(), named, routes })
}

#[cfg(test)]
mod razor {
    use super::razor_component;

    #[test]
    fn a_razor_page_becomes_its_component_with_its_routes_injections_and_code() {
        let page = "\u{feff}@page \"/catalog\"\n@inject CatalogService Catalog\n@attribute [Authorize]\n@code {\n    protected override async Task OnInitializedAsync()\n    {\n        items = await Catalog.GetItems();\n    }\n}\n";
        let held = razor_component(page.as_bytes(), "src/Pages/Catalog.razor").unwrap();
        let text = String::from_utf8(held.source).unwrap();
        assert_eq!(held.routes, vec!["/catalog"]);
        assert_eq!(held.named, "Catalog");
        assert!(text.starts_with("[Authorize] class Catalog : ComponentBase { \nCatalogService Catalog;\n"), "{text}");
        assert!(text.contains("protected override async Task OnInitializedAsync()"), "{text}");
        assert_eq!(text.lines().position(|line| line.contains("OnInitializedAsync")), Some(4));
    }
}
