use std::path::Path;

static VENDORED: &[&str] = &["clojure", "gdshader", "glimmer", "rescript", "tcl", "twig"];

fn main() {
    for grammar in VENDORED {
        let folder = Path::new("grammars").join(grammar);
        let mut build = cc::Build::new();
        build
            .include(&folder)
            .flag_if_supported("-Wno-unused-parameter")
            .flag_if_supported("-Wno-unused-but-set-variable")
            .file(folder.join("parser.c"));
        println!("cargo:rerun-if-changed={}", folder.join("parser.c").display());
        let scanner = folder.join("scanner.c");
        if scanner.exists() {
            println!("cargo:rerun-if-changed={}", scanner.display());
            build.file(scanner);
        }
        build.compile(&format!("tree-sitter-{grammar}"));
    }
}
