use std::collections::{BTreeMap, BTreeSet};
use rustc_hash::FxHashMap as HashMap;
use std::sync::LazyLock;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;
use crate::patterns::{found, Found};

struct Practice {
    pattern: &'static str,
    family: &'static str,
    evidence: &'static str,
    packages: &'static [&'static str],
}

const fn practice(
    pattern: &'static str,
    family: &'static str,
    evidence: &'static str,
    packages: &'static [&'static str],
) -> Practice {
    Practice { pattern, family, evidence, packages }
}

static PRACTICES: &[Practice] = &[
    practice("circuit breaker and retry", "resilience", "calls to others retried and broken off when they keep failing", &[
        "polly", "Microsoft.Extensions.Http.Resilience", "Microsoft.Extensions.Resilience", "io.github.resilience4j",
        "opossum", "cockatiel", "tenacity", "backoff", "p-retry", "async-retry", "retry", "failsafe",
        "com.netflix.hystrix", "github.com/sony/gobreaker", "github.com/cenkalti/backoff", "retrying", "retriable",
        "stoplight"]),
    practice("rate limiting", "resilience", "requests limited to a rate", &[
        "express-rate-limit", "rate-limiter-flexible", "bottleneck", "slowapi", "django-ratelimit", "rack-attack",
        "AspNetCoreRateLimit", "Microsoft.AspNetCore.RateLimiting", "bucket4j", "com.bucket4j", "golang.org/x/time/rate",
        "github.com/ulule/limiter", "@nestjs/throttler", "@upstash/ratelimit", "limiter"]),
    practice("caching", "data", "results kept close to be served again", &[
        "node-cache", "lru-cache", "cachetools", "Microsoft.Extensions.Caching", "com.github.ben-manes.caffeine",
        "spring-boot-starter-cache", "keyv", "cache-manager", "@nestjs/cache-manager", "django-redis", "flask-caching",
        "dogpile.cache", "github.com/patrickmn/go-cache", "moka", "quick-lru"]),
    practice("input validation", "boundary", "what comes in checked against a declared shape", &[
        "zod", "joi", "yup", "class-validator", "valibot", "ajv", "superstruct", "FluentValidation", "pydantic",
        "marshmallow", "cerberus", "jakarta.validation", "javax.validation", "org.hibernate.validator",
        "express-validator", "github.com/go-playground/validator", "vee-validate", "@sinclair/typebox", "io-ts",
        "dry-validation", "validator"]),
    practice("object mapping", "boundary", "one shape of a record mapped onto another", &[
        "AutoMapper", "Mapster", "org.mapstruct", "org.modelmapper", "class-transformer", "@automapper", "dozer",
        "Riok.Mapperly"]),
    practice("state machine", "behaviour", "behaviour decided by an explicit set of states and transitions", &[
        "xstate", "@xstate", "Stateless", "org.springframework.statemachine", "transitions", "aasm", "statesman",
        "robot3", "javascript-state-machine", "github.com/looplab/fsm", "python-statemachine", "Automatonymous"]),
    practice("reactive streams", "behaviour", "values handled as streams over time", &[
        "rxjs", "io.projectreactor", "reactor-core", "io.reactivex", "System.Reactive", "RxSwift", "most", "baconjs",
        "kotlinx-coroutines-reactive"]),
    practice("background jobs", "workflow", "work queued to be done outside the request", &[
        "bullmq", "bull", "bee-queue", "agenda", "sidekiq", "resque", "delayed_job", "good_job", "solid_queue",
        "celery", "rq", "dramatiq", "huey", "Hangfire", "org.quartz-scheduler", "Quartz", "graphile-worker",
        "pg-boss", "github.com/hibiken/asynq", "github.com/riverqueue/river", "oban", "que", "sneakers", "arq"]),
    practice("event sourcing", "data", "state rebuilt from the events that changed it", &[
        "EventStore.Client", "Marten", "org.axonframework", "eventide", "commanded", "@eventstore/db-client",
        "eventsourcing", "sequent", "rails_event_store", "Eventuous", "EventFlow", "github.com/hallgren/eventsourcing"]),
    practice("sagas", "workflow", "a long-running process coordinated across steps and services", &[
        "MassTransit", "NServiceBus", "Rebus", "org.axonframework.modelling.saga", "@temporalio", "temporalio"]),
    practice("message bus", "messaging", "messages carried between parts through a bus", &[
        "MassTransit", "NServiceBus", "Rebus", "Wolverine", "Brighter", "Paramore.Brighter", "@nestjs/microservices",
        "moleculer", "seneca", "spring-cloud-stream", "org.springframework.amqp", "org.springframework.kafka",
        "watermill", "github.com/ThreeDotsLabs/watermill", "faust", "kombu"]),
    practice("mediator", "messaging", "requests sent through a mediator to their one handler", &[
        "MediatR", "@nestjs/cqrs", "mediatr", "Mediator.SourceGenerator", "Cortex.Mediator", "github.com/mehdihadeli/go-mediatr"]),
    practice("GraphQL API", "interface", "clients ask for exactly the data they want through one graph", &[
        "graphql", "@apollo/server", "apollo-server", "@nestjs/graphql", "HotChocolate", "graphene", "strawberry",
        "ariadne", "graphql-ruby", "github.com/99designs/gqlgen", "com.graphql-java", "juniper", "async-graphql",
        "type-graphql", "pothos", "@pothos", "graphql-yoga", "mercurius"]),
    practice("gRPC", "interface", "services called through generated contracts over gRPC", &[
        "@grpc/grpc-js", "grpc", "grpcio", "Grpc.AspNetCore", "Grpc.Net.Client", "google.golang.org/grpc", "tonic",
        "io.grpc", "@connectrpc", "nice-grpc"]),
    practice("typed RPC", "interface", "the client calls server procedures with shared types", &[
        "@trpc/server", "@trpc/client", "@orpc", "telefunc"]),
    practice("feature flags", "delivery", "behaviour switched on and off without a deploy", &[
        "@openfeature", "openfeature", "Microsoft.FeatureManagement", "flipper", "django-waffle", "togglz",
        "flagsmith", "unleash-client", "@unleash", "@growthbook", "launchdarkly", "@launchdarkly", "configcat"]),
    practice("API gateway", "architecture", "one front door that routes requests to the services behind it", &[
        "Yarp.ReverseProxy", "Ocelot", "http-proxy-middleware", "express-http-proxy", "@fastify/http-proxy",
        "org.springframework.cloud.gateway", "spring-cloud-starter-gateway", "http-proxy", "@nestjs/microservices"]),
    practice("server-side rendering", "interface", "pages rendered on the server before they reach the browser", &[
        "next", "nuxt", "@remix-run", "@sveltejs/kit", "@angular/ssr", "@builder.io/qwik-city", "solid-start",
        "@solidjs/start", "@tanstack/start", "astro"]),
    practice("static site generation", "interface", "pages built ahead of time and served as files", &[
        "gatsby", "@11ty/eleventy", "hexo", "vuepress", "vitepress", "@docusaurus/core", "jekyll", "hugo"]),
    practice("object-relational mapping", "data", "records mapped to objects by an ORM", &[
        "typeorm", "sequelize", "@prisma/client", "prisma", "drizzle-orm", "mikro-orm", "@mikro-orm", "objection",
        "sqlalchemy", "django", "peewee", "tortoise", "Microsoft.EntityFrameworkCore", "org.hibernate",
        "jakarta.persistence", "javax.persistence", "gorm.io", "github.com/uptrace/bun", "entgo.io", "diesel",
        "sea-orm", "activerecord", "sequel", "doctrine", "illuminate/database", "Dapper", "exposed", "room"]),
    practice("aspect-oriented concerns", "architecture", "cross-cutting concerns woven around the code they apply to", &[
        "org.aspectj", "spring-aop", "PostSharp", "Castle.Core", "AspectInjector", "Metalama"]),
    practice("serverless functions", "architecture", "code run as functions on demand by a platform", &[
        "aws-lambda", "@types/aws-lambda", "@aws-lambda-powertools", "Amazon.Lambda.Core", "Amazon.Lambda",
        "azure-functions", "@azure/functions", "Microsoft.Azure.Functions.Worker", "firebase-functions",
        "@vercel/node", "@netlify/functions", "functions-framework", "@google-cloud/functions-framework",
        "github.com/aws/aws-lambda-go", "lambda_runtime", "serverless", "sst"]),
    practice("internationalization", "interface", "text kept apart from code so it can be translated", &[
        "i18next", "react-i18next", "next-intl", "react-intl", "vue-i18n", "@angular/localize", "ngx-translate",
        "@ngx-translate", "gettext", "babel", "i18n", "rails-i18n", "Microsoft.Extensions.Localization", "fluent",
        "@lingui", "typesafe-i18n", "@formatjs"]),
    practice("dependency injection", "architecture", "collaborators handed in by a container rather than built in place", &[
        "Microsoft.Extensions.DependencyInjection", "Autofac", "Ninject", "SimpleInjector", "inversify", "tsyringe",
        "typedi", "awilix", "@nestjs/core", "com.google.inject", "com.google.dagger", "dagger", "org.koin",
        "io.insert-koin", "injector", "dependency-injector", "github.com/google/wire", "go.uber.org/fx", "go.uber.org/dig",
        "shaku", "dry-container", "Swinject", "Resolver", "get_it", "injectable", "org.springframework"]),
];

static PRACTICE_INDEX: LazyLock<HashMap<String, Vec<(usize, bool)>>> = LazyLock::new(|| {
    let mut held: HashMap<String, Vec<(usize, bool)>> = HashMap::default();
    for (at, practice) in PRACTICES.iter().enumerate() {
        for package in practice.packages {
            let spans_segments = package.starts_with('@') || package.contains(['.', '/']);
            held.entry(package.to_ascii_lowercase()).or_default().push((at, spans_segments));
        }
    }
    held
});

fn practices_of(specifier: &str) -> Vec<usize> {
    let lowered = specifier.trim().trim_start_matches("node:").to_ascii_lowercase();
    if lowered.is_empty() || lowered.starts_with('.') || !lowered.is_ascii() {
        return Vec::new();
    }
    let index = &*PRACTICE_INDEX;
    let mut held: Vec<usize> = index.get(&lowered).into_iter().flatten().map(|(at, _)| *at).collect();
    for (at, letter) in lowered.char_indices() {
        let submodule = matches!(letter, '/' | '.' | ':');
        if !submodule && !matches!(letter, '-' | '_') {
            continue;
        }
        for (practice, spans_segments) in index.get(&lowered[..at]).into_iter().flatten() {
            if *spans_segments || submodule {
                held.push(*practice);
            }
        }
    }
    held.sort();
    held.dedup();
    held
}

static BUILT_BY_ITSELF: &[&str] = &["AggregateRoot", "IAggregateRoot", "Aggregate", "AggregateBase"];
static VALUE_OBJECTS: &[&str] = &["ValueObject", "IValueObject"];
static DOMAIN_EVENTS: &[&str] = &["DomainEvent", "IDomainEvent", "INotification"];
static RUNS_IN_THE_BACKGROUND: &[&str] = &["BackgroundService", "IHostedService", "IJob", "Job", "ApplicationJob", "ActiveJob::Base"];
static WRAPS_EVERY_REQUEST: &[&str] = &["IPipelineBehavior", "IPipelineBehaviour", "NestInterceptor", "HandlerInterceptor", "IInterceptor", "IActionFilter", "IAsyncActionFilter"];
static WOVEN_BY_DECORATION: &[&str] = &["Around", "Aspect", "Before", "After", "Cacheable", "CacheEvict", "Transactional", "Retryable", "CircuitBreaker", "UseInterceptors", "UseGuards"];
static RENDERED_FROM: &[&str] = &[".blade.php", ".cshtml", ".ejs", ".erb", ".haml", ".hbs", ".j2", ".jinja", ".jinja2", ".liquid", ".mustache", ".njk", ".pug", ".razor", ".slim", ".twig"];
static VIEW_MODELS: &[&str] = &["ViewModel", "ObservableObject", "INotifyPropertyChanged", "BindableBase", "ReactiveObject"];
static KEEPS_ITS_OWN_PLACE: &[&str] = &["objects", "save", "update", "destroy", "delete", "create", "find", "where", "all"];

pub struct Sources<'a> {
    pub graph: &'a crate::shared::Graph<'a>,
    pub nodes: &'a [IndexNode],
    pub edges: &'a [IndexEdge],
    pub imports: &'a [ImportFact],
    pub declared: &'a [&'a str],
    pub type_references: &'a [TypeReferenceFact],
    pub entry_points: &'a [EntryPoint],
    pub exit_points: &'a [ExitPoint],
    pub roles: &'a crate::roles::Roles,
    pub paths: &'a [&'a str],
    pub serving_projects: u32,
    pub messages: usize,
    pub topics: usize,
}

pub fn derive(sources: &Sources) -> Vec<Found> {
    let tested = |file: u32| sources.paths.get(file as usize).is_some_and(|path| crate::paths::is_test(path));
    let mut found_here: Vec<Found> = Vec::new();

    let mut evidenced: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for package in sources.declared {
        for at in practices_of(package) {
            evidenced.entry(at).or_default().insert(package.to_string());
        }
    }
    for import in sources.imports.iter().filter(|import| !tested(import.file)) {
        for at in practices_of(&import.specifier) {
            evidenced.entry(at).or_default().insert(import.specifier.clone());
        }
    }
    for (at, packages) in evidenced {
        let practice = &PRACTICES[at];
        let mut held = found(practice.pattern, practice.family, practice.evidence, packages.len() as u32);
        held.examples = packages.into_iter().take(6).collect();
        found_here.push(held);
    }

    let mut through_bases: BTreeMap<(&'static str, &'static str, &'static str), BTreeSet<String>> = BTreeMap::new();
    for reference in sources.type_references.iter().filter(|reference| !tested(reference.file)) {
        let base = crate::names::leaf(reference.name.as_str());
        let noted = [
            (BUILT_BY_ITSELF, "domain-driven design", "domain", "aggregates guard their own invariants"),
            (VALUE_OBJECTS, "value objects", "domain", "values compared by what they hold, not who they are"),
            (DOMAIN_EVENTS, "domain events", "domain", "the domain announces what happened in it"),
            (RUNS_IN_THE_BACKGROUND, "background jobs", "workflow", "work queued to be done outside the request"),
            (WRAPS_EVERY_REQUEST, "pipeline behaviours", "architecture", "every request passes through the same wrapping steps"),
        ];
        for (bases, pattern, family, evidence) in noted {
            if bases.contains(&base) {
                through_bases.entry((pattern, family, evidence)).or_default().insert(reference.source.clone());
            }
        }
    }
    let mut woven: BTreeSet<String> = BTreeSet::new();
    for node in sources.nodes.iter().filter(|node| !tested(node.file)) {
        if node.decorators.iter().any(|decorator| WOVEN_BY_DECORATION.contains(&crate::names::leaf(&decorator.name))) {
            woven.insert(node.id.clone());
        }
    }
    if !woven.is_empty() {
        through_bases
            .entry(("aspect-oriented concerns", "architecture", "cross-cutting concerns woven around the code they apply to"))
            .or_default()
            .extend(woven);
    }
    for ((pattern, family, evidence), sources_held) in through_bases {
        if let Some(existing) = found_here.iter_mut().find(|held| held.pattern == pattern) {
            existing.count += sources_held.len() as u32;
            existing.examples.extend(sources_held.into_iter().take(6));
            continue;
        }
        let mut held = found(pattern, family, evidence, sources_held.len() as u32);
        held.examples = sources_held.into_iter().take(6).collect();
        found_here.push(held);
    }

    let roles: HashMap<&str, u32> = sources.roles.by_role.iter().map(|(role, count)| (role.as_str(), *count)).collect();
    let rendered = sources
        .paths
        .iter()
        .filter(|path| {
            let lowered = path.to_ascii_lowercase();
            RENDERED_FROM.iter().any(|ending| lowered.ends_with(ending)) && !crate::paths::is_test(path)
        })
        .count() as u32;
    let controllers = roles.get("controller").copied().unwrap_or(0);
    if controllers > 0 && rendered > 0 && roles.get("model").copied().unwrap_or(0) > 0 {
        found_here.push(found("model-view-controller", "architecture", "controllers take requests, models keep data, views render it", controllers + rendered));
    }
    let view_models = sources
        .nodes
        .iter()
        .filter(|node| node.kind.is_type() && !tested(node.file))
        .filter(|node| node.name.ends_with("ViewModel"))
        .count() as u32
        + sources
            .type_references
            .iter()
            .filter(|reference| VIEW_MODELS.contains(&crate::names::leaf(reference.name.as_str())) && !tested(reference.file))
            .count() as u32;
    if view_models >= 2 {
        found_here.push(found("model-view-viewmodel", "architecture", "views bound to view models that hold their state", view_models));
    }

    if let Some(held) = layered_by_dependency(sources) {
        found_here.push(held);
    }
    if let Some(held) = ports_and_adapters(sources) {
        found_here.push(held);
    }

    let middleware = roles.get("middleware").copied().unwrap_or(0);
    if middleware >= 2 {
        found_here.push(found("middleware pipeline", "architecture", "requests pass through a chain of middleware", middleware));
    }
    let scheduled = sources.entry_points.iter().filter(|entry| entry.kind == "schedule" && !tested(entry.file)).count() as u32;
    if scheduled > 0 {
        found_here.push(found("scheduled jobs", "workflow", "work run on a schedule", scheduled));
    }
    let webhooks = sources
        .entry_points
        .iter()
        .filter(|entry| entry.kind == "http" && !tested(entry.file))
        .filter(|entry| entry.path.as_deref().is_some_and(|path| path.to_ascii_lowercase().contains("webhook")))
        .count() as u32;
    if webhooks > 0 {
        found_here.push(found("webhooks", "interface", "other systems call in when something happens on their side", webhooks));
    }
    let served = sources.entry_points.iter().filter(|entry| entry.kind == "http" && !tested(entry.file)).count() as u32;
    if served > 0 {
        found_here.push(found("HTTP API", "interface", "requests served over HTTP", served));
    }
    let graphs = sources.entry_points.iter().filter(|entry| entry.kind == "graphql").count() as u32;
    if graphs > 0 {
        match found_here.iter_mut().find(|held| held.pattern == "GraphQL API") {
            Some(existing) => existing.count += graphs,
            None => found_here.push(found("GraphQL API", "interface", "clients ask for exactly the data they want through one graph", graphs)),
        }
    }
    let outboxed = sources
        .nodes
        .iter()
        .filter(|node| node.kind.is_type() && !tested(node.file))
        .filter(|node| {
            let lowered = node.name.to_ascii_lowercase();
            lowered.contains("outbox") || lowered.contains("integrationeventlog")
        })
        .count() as u32;
    if outboxed > 0 && (sources.messages > 0 || sources.topics > 0) {
        found_here.push(found("transactional outbox", "messaging", "messages kept with the data and sent once it is saved", outboxed));
    }
    let evented = sources.messages + sources.topics;
    let talk_to_each_other = evented > 0 || found_here.iter().any(|held| matches!(held.pattern, "gRPC" | "message bus"));
    if sources.serving_projects >= 2 && talk_to_each_other {
        found_here.push(found("microservices", "architecture", "separately served services that talk to each other", sources.serving_projects));
        if evented > 0 {
            found_here.push(found("event-driven architecture", "architecture", "services react to events rather than calling each other", evented as u32));
        }
    } else if sources.serving_projects >= 2 {
        found_here.push(found("several served applications", "architecture", "more than one application served from this codebase", sources.serving_projects));
    } else if sources.serving_projects == 1 {
        found_here.push(found("monolith", "architecture", "one served system", 1));
    }

    let modelled_self_kept = sources
        .exit_points
        .iter()
        .filter(|exit| exit.id.ends_with(":model") && !tested(exit.file))
        .filter(|exit| KEEPS_ITS_OWN_PLACE.contains(&exit.operation.to_ascii_lowercase().as_str()))
        .count() as u32;
    let kept_by_mapper = sources.exit_points.iter().filter(|exit| exit.id.ends_with(":store") && !tested(exit.file)).count() as u32;
    if modelled_self_kept > 0 {
        found_here.push(found("active record", "data", "each record saves and finds itself", modelled_self_kept));
    }
    if kept_by_mapper > 0 {
        found_here.push(found("data mapper", "data", "records kept by a separate mapper or context", kept_by_mapper));
    }
    found_here
}

static INNER_RING: &[&str] = &["core", "domain", "entities", "model", "models"];
static MIDDLE_RING: &[&str] = &["application", "usecases", "use-cases", "services"];
static OUTER_RING: &[&str] = &["infrastructure", "infra", "persistence", "data", "adapters"];

fn ring_of(project: &str) -> Option<u32> {
    let lowered = project.to_ascii_lowercase();
    let leaf = lowered.rsplit(['/', '.', ':']).next().unwrap_or(&lowered);
    if INNER_RING.contains(&leaf) {
        Some(0)
    } else if MIDDLE_RING.contains(&leaf) {
        Some(1)
    } else if OUTER_RING.contains(&leaf) {
        Some(2)
    } else {
        None
    }
}

fn layered_by_dependency(sources: &Sources) -> Option<Found> {
    let reaches = &sources.graph.project_reaches;
    let ringed: Vec<(&str, u32)> = reaches
        .keys()
        .chain(reaches.values().flatten())
        .filter_map(|project| Some((*project, ring_of(project)?)))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let has = |ring: u32| ringed.iter().any(|(_, held)| *held == ring);
    if !(has(0) && has(2)) {
        return None;
    }
    let mut inward = 0u32;
    let mut outward: Vec<String> = Vec::new();
    for (from, targets) in reaches {
        let Some(above) = ring_of(from) else { continue };
        for to in targets {
            let Some(below) = ring_of(to) else { continue };
            if below < above {
                inward += 1;
            } else if below > above {
                outward.push(format!("{from} → {to}"));
            }
        }
    }
    if inward == 0 {
        return None;
    }
    let mut held = found(
        "clean architecture",
        "architecture",
        "dependencies point inward, from infrastructure to the domain",
        inward,
    );
    held.examples = outward.into_iter().take(6).map(|departure| format!("points outward: {departure}")).collect();
    Some(held)
}

fn ports_and_adapters(sources: &Sources) -> Option<Found> {
    let reaches = &sources.graph.project_reaches;
    let declared_in: HashMap<&str, (&str, &str)> = sources
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Interface)
        .filter_map(|node| Some((node.id.as_str(), (node.name.as_str(), node.project.as_deref()?))))
        .collect();
    let mut ports: BTreeSet<&str> = BTreeSet::new();
    for edge in sources.edges.iter().filter(|edge| edge.kind == EdgeKind::Implements || edge.kind == EdgeKind::Extends) {
        let Some((named, owner)) = declared_in.get(edge.target.as_str()) else { continue };
        let Some(adapter) = sources.graph.at(edge.source.as_str()).and_then(|at| sources.nodes[at].project.as_deref()) else { continue };
        let inverted = adapter != *owner && !reaches.get(owner).is_some_and(|held| held.contains(adapter));
        if inverted {
            ports.insert(named);
        }
    }
    (ports.len() >= 2).then(|| {
        let mut held = found(
            "ports and adapters",
            "architecture",
            "the core declares what it needs and outer projects plug in the implementations",
            ports.len() as u32,
        );
        held.examples = ports.into_iter().take(6).map(str::to_string).collect();
        held
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_package_names_the_practice_it_brings() {
        let named = |specifier: &str| -> Vec<&str> {
            practices_of(specifier).into_iter().map(|at| PRACTICES[at].pattern).collect()
        };
        assert!(named("Polly").contains(&"circuit breaker and retry"));
        assert!(named("@nestjs/cqrs").contains(&"mediator"));
        assert!(named("zod").contains(&"input validation"));
        assert!(named("@xstate/react").contains(&"state machine"));
        assert!(named("zodiac").is_empty());
        assert!(named("next-auth").is_empty());
        assert!(named("next/router").contains(&"server-side rendering"));
        assert!(named("sqlalchemy.orm").contains(&"object-relational mapping"));
    }

    #[test]
    fn a_project_sits_in_the_ring_its_name_places_it_in() {
        assert_eq!(ring_of("subproject:src/Ordering.Domain"), Some(0));
        assert_eq!(ring_of("subproject:src/Ordering.Infrastructure"), Some(2));
        assert_eq!(ring_of("subproject:src/Ordering.API"), None);
    }
}
