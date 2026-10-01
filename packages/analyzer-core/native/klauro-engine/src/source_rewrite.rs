use std::collections::BTreeSet;
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
        if continues_a_promise(source, after + 1) {
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

static PROMISE_METHODS: &[&[u8]] = &[b"catch", b"finally", b"then"];

fn continues_a_promise(source: &[u8], from: usize) -> bool {
    let mut end = from;
    while end < source.len() && is_identifier_byte(source[end]) {
        end += 1;
    }
    PROMISE_METHODS.contains(&&source[from..end])
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

pub const RENDERS: &str = "BuildRenderTree";

static LIFECYCLE: &[&str] = &["OnInitializedAsync", "OnInitialized", "OnParametersSetAsync", "OnParametersSet"];

static NOT_A_MEMBER: &[&str] = &[
    "if", "else", "foreach", "for", "while", "switch", "using", "code", "functions", "inject", "page",
    "attribute", "bind", "key", "ref", "typeof", "nameof", "await", "new", "default", "true", "false", "null",
];

fn called_in(code: &str, named: &str) -> bool {
    code.match_indices(named).any(|(at, _)| {
        let before = code[..at].chars().next_back();
        let after = code[at + named.len()..].trim_start().chars().next();
        !before.is_some_and(|letter| letter.is_alphanumeric() || letter == '_' || letter == '.') && after == Some('(')
    })
}

fn identifiers_called(value: &str, into: &mut BTreeSet<String>) {
    let value = value.trim().trim_start_matches('@').trim_start_matches('(').trim_end_matches(')');
    if !value.is_empty() && value.chars().all(|letter| letter.is_alphanumeric() || letter == '_') {
        if value.starts_with(char::is_alphabetic) && !NOT_A_MEMBER.contains(&value) {
            into.insert(value.to_string());
        }
        return;
    }
    let letters: Vec<char> = value.chars().collect();
    let mut at = 0;
    while at < letters.len() {
        if letters[at].is_alphabetic() && (at == 0 || !(letters[at - 1].is_alphanumeric() || letters[at - 1] == '_' || letters[at - 1] == '.')) {
            let start = at;
            while at < letters.len() && (letters[at].is_alphanumeric() || letters[at] == '_') {
                at += 1;
            }
            let named: String = letters[start..at].iter().collect();
            let mut next = at;
            while next < letters.len() && letters[next] == ' ' {
                next += 1;
            }
            if next < letters.len() && letters[next] == '(' && !NOT_A_MEMBER.contains(&named.as_str()) {
                into.insert(named);
            }
            continue;
        }
        at += 1;
    }
}

fn bound_in_markup(line: &str, into: &mut BTreeSet<String>, handlers: &mut BTreeSet<String>) {
    let mut rest = line;
    while let Some(at) = rest.find('=') {
        let before = &rest[..at];
        let attribute = before.rsplit(|letter: char| letter.is_whitespace() || letter == '<').next().unwrap_or("");
        let after = &rest[at + 1..];
        let quoted = after.strip_prefix('"').and_then(|held| held.find('"').map(|end| &held[..end]));
        if let Some(value) = quoted {
            let handler = attribute.strip_prefix("@on").is_some_and(|event| !event.contains(':'))
                || attribute.strip_prefix("On").is_some_and(|event| event.starts_with(char::is_uppercase));
            if handler {
                identifiers_called(value, into);
                if attribute.starts_with("@on") {
                    identifiers_called(value, handlers);
                }
            }
        }
        rest = after;
    }
    let letters: Vec<char> = line.chars().collect();
    for (at, letter) in letters.iter().enumerate() {
        if *letter == '<' && letters.get(at + 1).is_some_and(|next| next.is_uppercase()) {
            let named: String =
                letters[at + 1..].iter().take_while(|next| next.is_alphanumeric() || **next == '_').collect();
            into.insert(named);
        }
        if *letter == '@' && letters.get(at + 1).is_some_and(|next| next.is_alphabetic()) {
            let named: String =
                letters[at + 1..].iter().take_while(|next| next.is_alphanumeric() || **next == '_').collect();
            let next = letters.get(at + 1 + named.chars().count());
            if next == Some(&'(') && !NOT_A_MEMBER.contains(&named.as_str()) {
                into.insert(named);
            }
        }
    }
}

pub struct Component {
    pub source: Vec<u8>,
    pub named: String,
    pub routes: Vec<String>,
    pub handlers: Vec<String>,
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
    let mut rendered: BTreeSet<String> = BTreeSet::new();
    let mut handlers: BTreeSet<String> = BTreeSet::new();
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
        bound_in_markup(line, &mut rendered, &mut handlers);
        kept.push(String::new());
    }
    let code = kept.join("\n");
    let mut renders: Vec<String> = LIFECYCLE
        .iter()
        .filter(|named| called_in(&code, named))
        .map(|named| format!("{named}();"))
        .collect();
    renders.extend(rendered.iter().filter(|named| called_in(&code, named)).map(|named| format!("{named}();")));
    renders.extend(
        rendered
            .iter()
            .filter(|named| named.starts_with(char::is_uppercase) && !called_in(&code, named))
            .filter(|child| **child != named)
            .map(|child| format!("{child}.{RENDERS}();")),
    );
    let mut rewritten = format!("{} class {named} : ComponentBase {{ ", attributes.join(" "));
    rewritten.push_str(&code);
    rewritten.push_str(&format!("\nvoid {RENDERS}() {{ {} }}\n}}\n", renders.join(" ")));
    let handlers: Vec<String> = handlers.into_iter().filter(|named| called_in(&code, named) || code.contains(&format!(" {named}("))).collect();
    Some(Component { source: rewritten.into_bytes(), named, routes, handlers })
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
        assert!(text.contains("void BuildRenderTree() { OnInitializedAsync(); }"), "{text}");
    }

    #[test]
    fn what_the_markup_binds_and_renders_is_what_the_page_does() {
        let page = "@page \"/add\"\n<form @onsubmit=\"RegisterAsync\" @onsubmit:preventDefault=\"true\">\n<button @onclick=\"() => Remove(item)\">x</button>\n<EditForm OnValidSubmit=\"@Save\"></EditForm>\n<CartSummary Items=\"@items\" />\n<p>@Format(total)</p>\n@code {\n    void RegisterAsync() { }\n    void Remove(int item) { }\n    void Save() { }\n    string Format(int held) => \"\";\n}\n";
        let held = razor_component(page.as_bytes(), "src/Pages/Add.razor").unwrap();
        let text = String::from_utf8(held.source).unwrap();
        let renders = text.lines().find(|line| line.contains("void BuildRenderTree()")).unwrap();
        for called in ["RegisterAsync();", "Remove();", "Save();", "Format();", "CartSummary.BuildRenderTree();"] {
            assert!(renders.contains(called), "{called} in {renders}");
        }
        assert!(!renders.contains("EditForm();"), "{renders}");
        assert!(!renders.contains("true"), "{renders}");
    }
}

#[cfg(test)]
mod loaded_modules {
    use super::grammar_limitations;

    #[test]
    fn a_module_loaded_then_used_is_left_whole_and_a_type_taken_from_one_is_not() {
        let mut loaded = b"const load = () => import('./page').then((held) => held.Page);".to_vec();
        assert_eq!(grammar_limitations(&mut loaded), 0);
        assert_eq!(loaded, b"const load = () => import('./page').then((held) => held.Page);".to_vec());
        let mut typed = b"let page: import('./page').Page;".to_vec();
        assert_eq!(grammar_limitations(&mut typed), 1);
    }
}
