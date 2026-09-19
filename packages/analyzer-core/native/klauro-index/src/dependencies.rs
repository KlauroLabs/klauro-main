use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::entry_exit::EntryPoint;
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Dependency {
    pub name: String,
    pub role: &'static str,
    pub category: &'static str,
    pub imports: u32,
    pub entry_points: u32,
    pub exit_points: u32,
    pub projects: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Dependencies {
    pub dependencies: Vec<Dependency>,
    pub classified: u32,
    pub unclassified: u32,
}

struct Known {
    prefix: &'static str,
    role: &'static str,
    category: &'static str,
}

const fn known(prefix: &'static str, role: &'static str, category: &'static str) -> Known {
    Known { prefix, role, category }
}

static CATALOG: &[Known] = &[
    known("Illuminate", "framework", "web"),
    known("@angular", "framework", "ui"),
    known("@nestjs", "framework", "web"),
    known("actix-web", "framework", "web"),
    known("aiohttp", "framework", "web"),
    known("axum", "framework", "web"),
    known("django", "framework", "web"),
    known("dropwizard", "framework", "web"),
    known("express", "framework", "web"),
    known("fastapi", "framework", "web"),
    known("fastify", "framework", "web"),
    known("flask", "framework", "web"),
    known("gin-gonic", "framework", "web"),
    known("github.com/gin-gonic", "framework", "web"),
    known("github.com/gofiber", "framework", "web"),
    known("github.com/labstack/echo", "framework", "web"),
    known("hono", "framework", "web"),
    known("koa", "framework", "web"),
    known("laravel", "framework", "web"),
    known("next", "framework", "web"),
    known("nuxt", "framework", "web"),
    known("phoenix", "framework", "web"),
    known("rails", "framework", "web"),
    known("io.ktor.server", "framework", "web"),
    known("jakarta.ws.rs", "framework", "web"),
    known("javax.ws.rs", "framework", "web"),
    known("react", "framework", "ui"),
    known("rocket", "framework", "web"),
    known("package:flutter", "framework", "ui"),
    known("solid-js", "framework", "ui"),
    known("spring-boot", "framework", "web"),
    known("svelte", "framework", "ui"),
    known("symfony", "framework", "web"),
    known("vue", "framework", "ui"),
    known("androidx.compose", "framework", "ui"),
    known("androidx", "library", "ui"),
    known("@mui", "library", "ui"),
    known("classnames", "library", "ui"),
    known("package:hooks_riverpod", "library", "ui"),
    known("package:riverpod", "library", "ui"),
    known("package:provider", "library", "ui"),

    known("@prisma", "library", "data"),
    known("@supabase", "library", "data"),
    known("database/sql", "library", "data"),
    known("diesel", "library", "data"),
    known("drizzle-orm", "library", "data"),
    known("gorm.io", "library", "data"),
    known("knex", "library", "data"),
    known("mongoose", "library", "data"),
    known("pg", "library", "data"),
    known("redis", "library", "data"),
    known("sequelize", "library", "data"),
    known("alembic", "library", "data"),
    known("nlohmann", "library", "data"),
    known("sqlalchemy", "library", "data"),
    known("sqlx", "library", "data"),
    known("typeorm", "library", "data"),

    known("@grpc", "library", "rpc"),
    known("@trpc", "library", "rpc"),
    known("apollo-server", "library", "rpc"),
    known("graphene", "library", "rpc"),
    known("graphql", "library", "rpc"),
    known("strawberry", "library", "rpc"),
    known("net/http", "library", "network"),
    known("reqwest", "library", "network"),
    known("io.ktor.client", "library", "network"),
    known("package:dio", "library", "network"),
    known("requests", "library", "network"),
    known("undici", "library", "network"),

    known("@jest", "library", "test"),
    known("@playwright", "library", "test"),
    known("@testing-library", "library", "test"),
    known("cypress", "library", "test"),
    known("jest", "library", "test"),
    known("mocha", "library", "test"),
    known("pytest", "library", "test"),
    known("github.com/stretchr/testify", "library", "test"),
    known("testify", "library", "test"),
    known("vitest", "library", "test"),

    known("@opentelemetry", "library", "observability"),
    known("@sentry", "library", "observability"),
    known("pino", "library", "observability"),
    known("prom-client", "library", "observability"),
    known("tracing", "library", "observability"),
    known("winston", "library", "observability"),

    known("ajv", "library", "validation"),
    known("joi", "library", "validation"),
    known("pydantic", "library", "validation"),
    known("serde", "library", "validation"),
    known("yup", "library", "validation"),
    known("zod", "library", "validation"),

    known("clap", "library", "cli"),
    known("commander", "library", "cli"),
    known("cobra", "library", "cli"),
    known("yargs", "library", "cli"),

    known("com.fasterxml.jackson", "library", "data"),
    known("jakarta.persistence", "library", "data"),
    known("jakarta.validation", "library", "validation"),
    known("javax.persistence", "library", "data"),
    known("javax.validation", "library", "validation"),
    known("org.junit", "library", "test"),
    known("org.mockito", "library", "test"),
    known("org.slf4j", "library", "observability"),
    known("org.springframework.boot", "framework", "web"),
    known("org.springframework.cloud", "framework", "web"),
    known("org.springframework.data", "library", "data"),
    known("org.springframework.web", "framework", "web"),
    known("org.springframework", "framework", "web"),
    known("io.micrometer", "library", "observability"),

    known("Microsoft.AspNetCore", "framework", "web"),
    known("Microsoft.EntityFrameworkCore", "library", "data"),
    known("Microsoft.Extensions.Logging", "library", "observability"),
    known("Xunit", "library", "test"),

    known("dagger.hilt", "library", "injection"),
    known("javax.inject", "library", "injection"),
    known("me.tatarka.inject", "library", "injection"),
    known("org.koin", "library", "injection"),

    known("i18next", "library", "translation"),
    known("react-intl", "library", "translation"),
    known("svelte-i18n", "library", "translation"),
    known("ttag", "library", "translation"),

    known("esbuild", "library", "build"),
    known("rollup", "library", "build"),
    known("vite", "library", "build"),
    known("webpack", "library", "build"),
];

static RUNTIMES: &[(&str, &[&str])] = &[
    ("c", &["algorithm", "any", "array", "assert.h", "atomic", "bitset", "cassert", "cctype",
        "chrono", "cmath", "complex", "condition_variable", "cstddef", "cstdint", "cstdio",
        "cstdlib", "cstring", "ctime", "deque", "exception", "filesystem", "forward_list",
        "fstream", "functional", "future", "initializer_list", "iomanip", "iostream", "istream",
        "iterator", "limits", "list", "map", "memory", "mutex", "new", "numeric", "optional",
        "ostream", "queue", "random", "ratio", "regex", "set", "shared_mutex", "span", "sstream",
        "stack", "stdexcept", "streambuf", "string", "string_view", "system_error", "thread",
        "tuple", "type_traits", "typeindex", "typeinfo", "unordered_map", "unordered_set",
        "utility", "valarray", "variant", "vector", "ctype.h", "dirent.h", "errno.h", "fcntl.h", "float.h", "inttypes.h",
        "limits.h", "locale.h", "math.h", "pthread.h", "setjmp.h", "signal.h", "stdarg.h",
        "stdbool.h", "stddef.h", "stdint.h", "stdio.h", "stdlib.h", "string.h", "strings.h",
        "sys", "time.h", "unistd.h", "wchar.h", "wctype.h"]),
    ("csharp", &["Microsoft.CSharp", "Microsoft.Win32", "System"]),
    ("dart", &["dart"]),
    ("go", &["bufio", "bytes", "cmp", "compress", "container", "context", "crypto", "database",
        "embed", "encoding", "errors", "flag", "fmt", "go", "hash", "html", "image", "io", "iter",
        "log", "maps", "math", "mime", "net", "os", "path", "reflect", "regexp", "runtime",
        "slices", "sort", "strconv", "strings", "sync", "syscall", "testing", "text", "time",
        "unicode", "unsafe"]),
    ("haskell", &["GHC", "Prelude"]),
    ("java", &["java", "javax.annotation", "javax.naming", "javax.sql"]),
    ("kotlin", &["kotlin"]),
    ("python", &["abc", "argparse", "array", "ast", "asyncio", "base64", "binascii", "bisect",
        "calendar", "codecs", "collections", "contextlib", "copy", "csv", "ctypes", "dataclasses",
        "datetime", "decimal", "difflib", "email", "enum", "errno", "fnmatch", "functools",
        "gettext", "glob", "gzip", "hashlib", "heapq", "hmac", "html", "http", "importlib",
        "inspect", "io", "ipaddress", "itertools", "json", "locale", "logging", "math", "mimetypes",
        "multiprocessing", "operator", "os", "pathlib", "pickle", "platform", "pprint", "queue",
        "random", "re", "secrets", "select", "shutil", "signal", "socket", "sqlite3", "ssl",
        "stat", "statistics", "string", "struct", "subprocess", "sys", "tempfile", "textwrap",
        "threading", "time", "traceback", "types", "typing", "unicodedata", "unittest", "urllib",
        "uuid", "warnings", "weakref", "xml", "zipfile", "zlib"]),
    ("ruby", &["base64", "benchmark", "date", "digest", "erb", "fileutils", "json", "logger",
        "ostruct", "pathname", "securerandom", "set", "socket", "stringio", "tempfile", "time",
        "uri", "yaml"]),
    ("rust", &["alloc", "core", "std"]),
    ("swift", &["Combine", "Dispatch", "Foundation", "ObjectiveC", "Swift"]),
    ("typescript", &["assert", "buffer", "child_process", "cluster", "crypto", "dns", "events",
        "fs", "http", "http2", "https", "module", "net", "os", "path", "perf_hooks", "process",
        "querystring", "readline", "stream", "string_decoder", "timers", "tls", "tty", "url",
        "util", "vm", "worker_threads", "zlib"]),
];

fn runtime_of(language: &str, package: &str) -> bool {
    if package.starts_with("node:") {
        return true;
    }
    let language = match language {
        "cpp" => "c",
        "javascript" | "svelte" | "vue" => "typescript",
        other => other,
    };
    RUNTIMES
        .binary_search_by(|(known, _)| (*known).cmp(language))
        .ok()
        .is_some_and(|at| {
            RUNTIMES[at].1.iter().any(|known| package.starts_with(known) && bounded(package, known))
        })
}

fn head(text: &str, separator: char, keep: usize) -> &str {
    let mut end = 0;
    for (index, part) in text.split(separator).enumerate() {
        if index == keep {
            break;
        }
        end += part.len() + usize::from(index > 0);
    }
    &text[..end.min(text.len())]
}

static INTERNAL_ROOTS: &[&str] = &["crate", "self", "super"];

pub fn package_of(specifier: &str) -> Option<&str> {
    let trimmed = specifier.trim().trim_end_matches(['*', '.', ';']);
    if trimmed.is_empty() || trimmed.starts_with('.') || trimmed.starts_with('/') {
        return None;
    }
    if let Some(matched) = catalog_prefix(trimmed) {
        return Some(&trimmed[..matched.len()]);
    }
    if let Some(root) = trimmed.split("::").next().filter(|root| *root != trimmed) {
        return (!INTERNAL_ROOTS.contains(&root)).then_some(root);
    }
    if let Some(root) = trimmed.split('\\').next().filter(|root| *root != trimmed) {
        return Some(root);
    }
    if trimmed.starts_with('@') {
        return Some(head(trimmed, '/', 2));
    }
    if !trimmed.contains('/') && trimmed.contains('.') {
        return Some(head(trimmed, '.', 3));
    }
    if trimmed.split('/').next().is_some_and(|host| host.contains('.')) {
        return Some(head(trimmed, '/', 3));
    }
    if let Some(rest) = trimmed.strip_prefix("node:") {
        return Some(&trimmed[..5 + head(rest, '/', 1).len()]);
    }
    Some(head(trimmed, '/', 1))
}

fn declares(package: &str, own: &HashSet<&str>) -> bool {
    let name = package.strip_prefix("package:").unwrap_or(package);
    own.contains(name) || own.iter().any(|known| name.starts_with(known) && bounded(name, known))
}

fn bounded(package: &str, prefix: &str) -> bool {
    package.len() == prefix.len()
        || package
            .as_bytes()
            .get(prefix.len())
            .is_some_and(|next| matches!(next, b'/' | b'.'))
}

fn catalog_prefix(specifier: &str) -> Option<&'static str> {
    CATALOG
        .iter()
        .filter(|entry| specifier.starts_with(entry.prefix) && bounded(specifier, entry.prefix))
        .max_by_key(|entry| entry.prefix.len())
        .map(|entry| entry.prefix)
}

fn classify(package: &str) -> Option<&'static Known> {
    CATALOG
        .iter()
        .filter(|entry| package.starts_with(entry.prefix) && bounded(package, entry.prefix))
        .max_by_key(|entry| entry.prefix.len())
}

pub fn derive(
    imports: &[ImportFact],
    internal: &HashSet<String>,
    own: &HashSet<&str>,
    files: &[String],
    languages: &[&str],
    entry_points: &[EntryPoint],
    exit_points: &[crate::entry_exit::ExitPoint],
    project_of: &HashMap<&str, &str>,
) -> Dependencies {
    let mut found: HashMap<&str, Dependency> = HashMap::new();

    for fact in imports {
        if internal.contains(&fact.specifier) {
            continue;
        }
        let Some(package) = package_of(&fact.specifier) else { continue };
        if declares(package, own) {
            continue;
        }
        let language = languages.get(fact.file as usize).copied().unwrap_or_default();
        let entry = found.entry(package).or_insert_with(|| {
            let known = classify(package);
            let standard = known.is_none() && runtime_of(language, package);
            Dependency {
                name: package.to_string(),
                role: match (known, standard) {
                    (Some(found), _) => found.role,
                    (None, true) => "runtime",
                    (None, false) => "unclassified",
                },
                category: match (known, standard) {
                    (Some(found), _) => found.category,
                    (None, true) => "standard",
                    (None, false) => "",
                },
                imports: 0,
                entry_points: 0,
                exit_points: 0,
                projects: Vec::new(),
            }
        });
        entry.imports += 1;
        if let Some(project) = files
            .get(fact.file as usize)
            .and_then(|path| project_of.get(path.as_str()))
            && !entry.projects.iter().any(|known| known == project)
        {
            entry.projects.push((*project).to_string());
        }
    }

    for entry in entry_points {
        let Some(package) = entry
            .registrar
            .split('.')
            .next()
            .and_then(|_| package_of(&entry.registrar))
        else {
            continue;
        };
        if let Some(dependency) = found.get_mut(package) {
            dependency.entry_points += 1;
        }
    }
    for exit in exit_points {
        let Some(package) = package_of(&exit.target) else { continue };
        if let Some(dependency) = found.get_mut(package) {
            dependency.exit_points += 1;
        }
    }

    let mut dependencies: Vec<Dependency> = found.into_values().collect();
    for dependency in dependencies.iter_mut() {
        dependency.projects.sort();
    }
    dependencies.sort_by(|left, right| {
        right
            .imports
            .cmp(&left.imports)
            .then(left.name.cmp(&right.name))
    });
    let classified = dependencies
        .iter()
        .filter(|dependency| dependency.role != "unclassified")
        .count() as u32;
    let unclassified = dependencies.len() as u32 - classified;
    Dependencies { dependencies, classified, unclassified }
}

pub fn file_project(assignment: &[(String, String)]) -> HashMap<&str, &str> {
    assignment
        .iter()
        .map(|(path, project)| (path.as_str(), project.as_str()))
        .collect()
}
