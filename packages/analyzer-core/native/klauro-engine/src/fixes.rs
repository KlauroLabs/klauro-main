const FIX_WORDS: &[&str] = &["fix", "fixes", "fixed", "fixing", "bugfix", "bugfixes", "hotfix", "hotfixes", "bug", "bugs", "regression", "regressions", "revert", "reverts", "reverted", "reverting"];
const CLOSING_WORDS: &[&str] = &["close", "closes", "closed", "resolve", "resolves", "resolved"];
const FIX_TYPES: &[&str] = &["fix", "bugfix", "hotfix", "revert"];
const OTHER_TYPES: &[&str] = &["feat", "feature", "docs", "doc", "test", "tests", "chore", "refactor", "style", "ci", "build", "perf", "deps", "release", "wip"];
const DOCUMENTATION: &[&str] = &["md", "mdx", "rst", "txt", "adoc", "markdown"];
const CONFIGURATION: &[&str] = &["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "lock", "env", "properties", "editorconfig", "gitignore", "gitattributes", "npmrc", "prettierrc", "eslintrc"];
const NAMED_ASIDE: &[&str] = &["license", "licence", "changelog", "readme", "dockerfile", "codeowners", "authors", "contributing"];

fn conventional_type(subject: &str) -> Option<String> {
    let head = subject.split_once(':')?.0;
    let kind: String = head.chars().take_while(|letter| letter.is_ascii_alphabetic()).collect();
    let rest = &head[kind.len()..];
    let shaped = rest.is_empty() || (rest.starts_with('(') && rest.trim_end_matches('!').ends_with(')')) || rest == "!";
    (shaped && !kind.is_empty()).then(|| kind.to_ascii_lowercase())
}

pub fn is_fix(subject: &str) -> bool {
    if let Some(kind) = conventional_type(subject) {
        if FIX_TYPES.contains(&kind.as_str()) {
            return true;
        }
        if OTHER_TYPES.contains(&kind.as_str()) {
            return false;
        }
    }
    let lowered = subject.to_ascii_lowercase();
    let words: Vec<&str> = lowered.split(|letter: char| !letter.is_ascii_alphanumeric() && letter != '#').filter(|word| !word.is_empty()).collect();
    let narrates = |at: usize| at == 0 || matches!(words[at - 1], "and" | "also" | "then" | "bug" | "bugs");
    if words.iter().enumerate().any(|(at, word)| FIX_WORDS.contains(word) && (*word != "fixed" || narrates(at))) {
        return true;
    }
    words.windows(2).any(|pair| CLOSING_WORDS.contains(&pair[0]) && pair[1].starts_with('#') && pair[1][1..].chars().all(|digit| digit.is_ascii_digit()) && pair[1].len() > 1)
}

pub fn is_aside(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let name = lowered.rsplit('/').next().unwrap_or(&lowered);
    let extension = name.rsplit_once('.').map(|(_, extension)| extension).unwrap_or("");
    let stem = name.split('.').next().unwrap_or(name);
    crate::paths::is_test(path)
        || DOCUMENTATION.contains(&extension)
        || CONFIGURATION.contains(&extension)
        || NAMED_ASIDE.contains(&stem)
        || lowered.starts_with("docs/")
        || lowered.starts_with("doc/")
        || lowered.contains("/docs/")
        || lowered.starts_with(".github/")
        || lowered.starts_with(".circleci/")
        || (name.starts_with('.') && !name.contains('/') && extension.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subjects_that_say_they_fix_something_are_fixes() {
        for subject in [
            "Fix crash when the queue is empty",
            "fix(parser): handle trailing commas",
            "Bugfix: stale cache entry",
            "hotfix for login",
            "Revert \"Add retry\"",
            "Resolve #1234",
            "Handle null body, closes #88",
            "Fixed the off-by-one",
            "regression in sorting",
        ] {
            assert!(is_fix(subject), "{subject}");
        }
    }

    #[test]
    fn subjects_about_other_work_are_not_fixes() {
        for subject in [
            "feat: add fixture loader",
            "docs: fix typo in readme",
            "Add prefix handling",
            "give the speed budget room for a run's fixed cost",
            "Refactor the fixer registry",
            "chore(deps): bump bugsnag",
            "Merge branch 'main'",
            "Update the issue template",
        ] {
            assert!(!is_fix(subject), "{subject}");
        }
    }

    #[test]
    fn documentation_tests_and_configuration_are_set_aside() {
        for path in ["README.md", "docs/guide/start.rst", "src/app.test.ts", "tests/test_app.py", "package.json", ".github/workflows/ci.yml", "config/app.yaml", "Dockerfile", ".gitignore", "yarn.lock"] {
            assert!(is_aside(path), "{path}");
        }
        for path in ["src/app.ts", "lib/parser.rs", "app/models/user.rb", "src/main/java/App.java", "web/styles/site.css"] {
            assert!(!is_aside(path), "{path}");
        }
    }
}
