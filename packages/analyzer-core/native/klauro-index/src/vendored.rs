use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_clojure() -> *const ();
}

pub const CLOJURE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_clojure) };

unsafe extern "C" {
    fn tree_sitter_tcl() -> *const ();
}

pub const TCL: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_tcl) };
