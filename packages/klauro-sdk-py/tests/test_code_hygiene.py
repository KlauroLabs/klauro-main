import ast
import io
import pathlib
import tokenize


def production_sources():
    return sorted((pathlib.Path(__file__).parents[1] / "src").rglob("*.py"))


def docstring_locations(tree):
    locations = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.body:
            continue
        first = node.body[0]
        if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
            locations.append(first.lineno)
    return locations


def test_production_python_is_comment_free_and_self_documenting():
    violations = []
    for path in production_sources():
        source = path.read_text(encoding="utf-8")
        comments = [token.start[0] for token in tokenize.generate_tokens(io.StringIO(source).readline) if token.type == tokenize.COMMENT]
        docstrings = docstring_locations(ast.parse(source, filename=str(path)))
        if comments or docstrings:
            violations.append((str(path), comments, docstrings))
    assert violations == []
