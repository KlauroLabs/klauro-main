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

unsafe extern "C" {
    fn tree_sitter_prisma() -> *const ();
}

pub const PRISMA: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_prisma) };

unsafe extern "C" {
    fn tree_sitter_thrift() -> *const ();
}

pub const THRIFT: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_thrift) };

unsafe extern "C" {
    fn tree_sitter_capnp() -> *const ();
}

pub const CAPNP: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_capnp) };

unsafe extern "C" {
    fn tree_sitter_haxe() -> *const ();
}

pub const HAXE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_haxe) };

unsafe extern "C" {
    fn tree_sitter_wgsl() -> *const ();
}

pub const WGSL: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_wgsl) };

unsafe extern "C" {
    fn tree_sitter_puppet() -> *const ();
}

pub const PUPPET: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_puppet) };

unsafe extern "C" {
    fn tree_sitter_awk() -> *const ();
}

pub const AWK: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_awk) };
