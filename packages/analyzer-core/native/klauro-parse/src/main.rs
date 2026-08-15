use std::io::Read;
use tree_sitter::{Node, Parser};

fn language(name: &str) -> Option<tree_sitter::Language> {
    Some(match name {
        "erlang" => tree_sitter_erlang::LANGUAGE.into(),
        "gleam" => tree_sitter_gleam::LANGUAGE.into(),
        "commonlisp" => tree_sitter_commonlisp::LANGUAGE_COMMONLISP.into(),
        "fortran" => tree_sitter_fortran::LANGUAGE.into(),
        "r" => tree_sitter_r::LANGUAGE.into(),
        "ada" => tree_sitter_ada::LANGUAGE.into(),
        "elm" => tree_sitter_elm::LANGUAGE.into(),
        "objc" => tree_sitter_objc::LANGUAGE.into(),
        "verilog" => tree_sitter_verilog::LANGUAGE.into(),
        "vhdl" => tree_sitter_vhdl::LANGUAGE.into(),
        "perl" => tree_sitter_perl::LANGUAGE.into(),
        "groovy" => tree_sitter_groovy::LANGUAGE.into(),
        "odin" => tree_sitter_odin::LANGUAGE.into(),
        "pascal" => tree_sitter_pascal::LANGUAGE.into(),
        "proto" => tree_sitter_proto::LANGUAGE.into(),
        "glsl" => tree_sitter_glsl::LANGUAGE_GLSL.into(),
        "hlsl" => tree_sitter_hlsl::LANGUAGE_HLSL.into(),
        "cmake" => tree_sitter_cmake::LANGUAGE.into(),
        "powershell" => tree_sitter_powershell::LANGUAGE.into(),
        "v" => tree_sitter_v::LANGUAGE.into(),
        "d" => tree_sitter_d::LANGUAGE.into(),
        "racket" => tree_sitter_racket::LANGUAGE.into(),
        "scheme" => tree_sitter_scheme::LANGUAGE.into(),
        "nix" => tree_sitter_nix::LANGUAGE.into(),
        "hcl" => tree_sitter_hcl::LANGUAGE.into(),
        "jsonnet" => tree_sitter_jsonnet::LANGUAGE.into(),
        "gdscript" => tree_sitter_gdscript::LANGUAGE.into(),
        "starlark" => tree_sitter_starlark::LANGUAGE.into(),
        "slang" => tree_sitter_slang::LANGUAGE_SLANG.into(),
        "ocaml" => tree_sitter_ocaml::LANGUAGE_OCAML.into(),
        "agda" => tree_sitter_agda::LANGUAGE.into(),
        "nickel" => tree_sitter_nickel::LANGUAGE.into(),
        "scala" => tree_sitter_scala::LANGUAGE.into(),
        "lua" => tree_sitter_lua::LANGUAGE.into(),
        "markdown" => tree_sitter_md::LANGUAGE.into(),
        "svelte" => tree_sitter_svelte_ng::LANGUAGE.into(),
        "embeddedtemplate" | "erb" => tree_sitter_embedded_template::LANGUAGE.into(),
        "matlab" => tree_sitter_matlab::LANGUAGE.into(),
        "rst" => tree_sitter_rst::LANGUAGE.into(),
        "prolog" => tree_sitter_prolog::LANGUAGE.into(),
        _ => return None,
    })
}

fn emit(n: Node, out: &mut String) {
    out.push('{');
    out.push_str(&format!(
        "\"t\":\"{}\",\"s\":{},\"e\":{},\"sr\":{},\"n\":{},\"c\":[",
        n.kind().replace('\\', "\\\\").replace('"', "\\\""),
        n.start_byte(),
        n.end_byte(),
        n.start_position().row,
        n.is_named()
    ));
    let mut first = true;
    let count = n.child_count();
    for i in 0..count {
        let c = n.child(i.try_into().unwrap()).unwrap();
        if !first { out.push(','); }
        first = false;
        emit(c, out);
    }
    out.push_str("]}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lang = args.get(1).map(|s| s.as_str()).unwrap_or("");
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).unwrap();
    let mut parser = Parser::new();
    match language(lang) {
        Some(l) => parser.set_language(&l).unwrap(),
        None => { println!("{{\"error\":\"unknown language: {}\"}}", lang); return; }
    }
    let tree = match parser.parse(&src, None) { Some(t) => t, None => { println!("{{\"error\":\"parse failed\"}}"); return; } };
    let mut out = String::new();
    emit(tree.root_node(), &mut out);
    println!("{}", out);
}
