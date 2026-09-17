use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_clojure() -> *const ();
}

pub const CLOJURE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_clojure) };

unsafe extern "C" {
    fn tree_sitter_tcl() -> *const ();
}

pub const TCL: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_tcl) };

unsafe extern "C" {
    fn tree_sitter_rescript() -> *const ();
}

pub const RESCRIPT: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_rescript) };

unsafe extern "C" {
    fn tree_sitter_twig() -> *const ();
}

pub const TWIG: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_twig) };

unsafe extern "C" {
    fn tree_sitter_glimmer() -> *const ();
}

pub const GLIMMER: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_glimmer) };

unsafe extern "C" {
    fn tree_sitter_gdshader() -> *const ();
}

pub const GDSHADER: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_gdshader) };
