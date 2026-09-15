fn main() {
    let cases: Vec<(&str, tree_sitter::Language, &str)> = vec![
        ("proto", tree_sitter_proto::LANGUAGE.into(), "syntax=\"proto3\";\nimport \"a.proto\";\nmessage User { string name = 1; }\nservice S { rpc Get(User) returns (User); }\n"),
        ("graphql", tree_sitter_graphql::LANGUAGE.into(), "type User { name: String }\ntype Query { user(id: ID): User }"),
        ("cmake", tree_sitter_cmake::LANGUAGE.into(), "function(build target)\n  add_library(${target} src.c)\nendfunction()\n"),
        ("make", tree_sitter_make::LANGUAGE.into(), "build: deps\n\tgo build ./...\ndeps:\n\tgo mod download\n"),
        ("powershell", tree_sitter_powershell::LANGUAGE.into(), "function Send-Item { param([string]$To) Write-Host $To }\nSend-Item -To x\n"),
        ("nix", tree_sitter_nix::LANGUAGE.into(), "{ pkgs }: { name = \"x\"; build = pkgs.mkDerivation { }; }"),
        ("elm", tree_sitter_elm::LANGUAGE.into(), "module A exposing (send)\nsend : String -> Bool\nsend to = pay to\n"),
        ("erlang", tree_sitter_erlang::LANGUAGE.into(), "-module(a).\n-export([send/1]).\nsend(To) -> pay(To).\n"),
        ("ocaml", tree_sitter_ocaml::LANGUAGE_OCAML.into(), "let send to = pay to\ntype user = { name : string }\n"),
        ("julia", tree_sitter_julia::LANGUAGE.into(), "struct User\n  name::String\nend\nfunction send(to::String)\n  pay(to)\nend\n"),
        ("hcl", tree_sitter_hcl::LANGUAGE.into(), "resource \"aws_s3_bucket\" \"b\" {\n  bucket = \"x\"\n}\n"),
        ("starlark", tree_sitter_starlark::LANGUAGE.into(), "def build(name):\n    cc_library(name = name)\n"),
        ("markdown", tree_sitter_md::LANGUAGE.into(), "# Title\n\n## Section\n\ntext\n"),
        ("xml", tree_sitter_xml::LANGUAGE_XML.into(), "<project><groupId>a</groupId></project>"),
    ];
    for (name, language, source) in cases {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).unwrap();
        let tree = parser.parse(source, None).unwrap();
        let sexp = tree.root_node().to_sexp();
        println!("=== {name}{}\n{}\n", if tree.root_node().has_error() { " ERROR" } else { "" }, &sexp[..sexp.len().min(560)]);
    }
}
