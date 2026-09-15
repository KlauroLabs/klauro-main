fn main() {
    let cases: Vec<(&str, tree_sitter::Language, &str)> = vec![
        ("fsharp", tree_sitter_fsharp::LANGUAGE_FSHARP.into(), "module A\ntype User = { Name: string }\nlet send (to: string) = pay to\n"),
        ("crystal", tree_sitter_crystal::LANGUAGE.into(), "class User\n  @name : String\n  def send(to)\n    pay(to)\n  end\nend\n"),
        ("nim", tree_sitter_nim::LANGUAGE.into(), "type User = object\n  name: string\nproc send(to: string): bool =\n  pay(to)\n"),
        ("v", tree_sitter_v::LANGUAGE.into(), "struct User { name string }\nfn (u User) send(to string) bool { return pay(to) }\n"),
        ("d", tree_sitter_d::LANGUAGE.into(), "class User { string name; bool send(string to) { return pay(to); } }"),
        ("pascal", tree_sitter_pascal::LANGUAGE.into(), "unit A;\ninterface\ntype TUser = class\n  Name: string;\n  function Send(const ATo: string): Boolean;\nend;\nimplementation\nend."),
        ("ada", tree_sitter_ada::LANGUAGE.into(), "package A is\n  type User is record\n    Name : String;\n  end record;\n  function Send (To_Addr : String) return Boolean;\nend A;\n"),
        ("matlab", tree_sitter_matlab::LANGUAGE.into(), "function out = send(to)\n  out = pay(to);\nend\n"),
        ("glsl", tree_sitter_glsl::LANGUAGE_GLSL.into(), "struct Light { vec3 pos; };\nvec4 shade(vec3 n) { return vec4(compute(n), 1.0); }\n"),
        ("odin", tree_sitter_odin::LANGUAGE.into(), "User :: struct { name: string }\nsend :: proc(to: string) -> bool { return pay(to) }\n"),
        ("jsonnet", tree_sitter_jsonnet::LANGUAGE.into(), "{ name: 'x', build(t):: run(t) }"),
        ("nickel", tree_sitter_nickel::LANGUAGE.into(), "{ name = \"x\", build = fun t => run t }"),
        ("ini", tree_sitter_ini::LANGUAGE.into(), "[core]\nname = x\n[remote]\nurl = y\n"),
        ("svelte", tree_sitter_svelte_ng::LANGUAGE.into(), "<script>export let name;</script><div>{name}</div>"),
    ];
    for (name, language, source) in cases {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).unwrap();
        let tree = parser.parse(source, None).unwrap();
        let sexp = tree.root_node().to_sexp();
        println!("=== {name}{}\n{}\n", if tree.root_node().has_error() { " ERROR" } else { "" }, &sexp[..sexp.len().min(520)]);
    }
}
