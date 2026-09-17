use std::collections::HashMap;

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
    known("@angular", "framework", "ui"),
    known("@nestjs", "framework", "web"),
    known("actix-web", "framework", "web"),
    known("aiohttp", "framework", "web"),
    known("axum", "framework", "web"),
    known("django", "framework", "web"),
    known("express", "framework", "web"),
    known("fastapi", "framework", "web"),
    known("fastify", "framework", "web"),
    known("flask", "framework", "web"),
    known("gin-gonic", "framework", "web"),
    known("hono", "framework", "web"),
    known("koa", "framework", "web"),
    known("laravel", "framework", "web"),
    known("next", "framework", "web"),
    known("nuxt", "framework", "web"),
    known("phoenix", "framework", "web"),
    known("rails", "framework", "web"),
    known("react", "framework", "ui"),
    known("rocket", "framework", "web"),
    known("solid-js", "framework", "ui"),
    known("spring-boot", "framework", "web"),
    known("svelte", "framework", "ui"),
    known("symfony", "framework", "web"),
    known("vue", "framework", "ui"),

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
    known("sqlalchemy", "library", "data"),
    known("sqlx", "library", "data"),
    known("typeorm", "library", "data"),

    known("@grpc", "library", "rpc"),
    known("@trpc", "library", "rpc"),
    known("apollo-server", "library", "rpc"),
    known("graphql", "library", "rpc"),
    known("net/http", "library", "network"),
    known("reqwest", "library", "network"),
    known("requests", "library", "network"),
    known("undici", "library", "network"),

    known("@jest", "library", "test"),
    known("@playwright", "library", "test"),
    known("@testing-library", "library", "test"),
    known("cypress", "library", "test"),
    known("jest", "library", "test"),
    known("mocha", "library", "test"),
    known("pytest", "library", "test"),
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

    known("esbuild", "library", "build"),
    known("rollup", "library", "build"),
    known("vite", "library", "build"),
    known("webpack", "library", "build"),
];

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

fn package_of(specifier: &str) -> Option<&str> {
    let trimmed = specifier.trim().trim_end_matches(['*', '.', ';']);
    if trimmed.is_empty() || trimmed.starts_with('.') || trimmed.starts_with('/') {
        return None;
    }
    if let Some(matched) = catalog_prefix(trimmed) {
        return Some(&trimmed[..matched.len()]);
    }
    if trimmed.starts_with('@') {
        return Some(head(trimmed, '/', 2));
    }
    if !trimmed.contains('/') && trimmed.contains('.') {
        return Some(head(trimmed, '.', 3));
    }
    if let Some(rest) = trimmed.strip_prefix("node:") {
        return Some(&trimmed[..5 + head(rest, '/', 1).len()]);
    }
    Some(head(trimmed, '/', 1))
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
    files: &[String],
    entry_points: &[EntryPoint],
    exit_points: &[crate::entry_exit::ExitPoint],
    project_of: &HashMap<&str, &str>,
) -> Dependencies {
    let mut found: HashMap<&str, Dependency> = HashMap::new();

    for fact in imports {
        let Some(package) = package_of(&fact.specifier) else { continue };
        let entry = found.entry(package).or_insert_with(|| {
            let known = classify(package);
            Dependency {
                name: package.to_string(),
                role: known.map(|found| found.role).unwrap_or("unclassified"),
                category: known.map(|found| found.category).unwrap_or(""),
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
