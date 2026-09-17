use std::path::Path;

static VENDORED: &[&str] = &["clojure"];

fn main() {
    for grammar in VENDORED {
        let folder = Path::new("grammars").join(grammar);
        println!("cargo:rerun-if-changed={}", folder.join("parser.c").display());
        cc::Build::new()
            .include(&folder)
            .flag_if_supported("-Wno-unused-parameter")
            .flag_if_supported("-Wno-unused-but-set-variable")
            .file(folder.join("parser.c"))
            .compile(&format!("tree-sitter-{grammar}"));
    }
}
