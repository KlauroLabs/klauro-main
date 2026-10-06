mod jenkins;
mod tables;
mod value;

use std::path::Path;

use serde::Serialize;

use value::{Kind, Value};

const LARGEST_SOURCE: u64 = 1_000_000;

#[derive(Serialize, Default)]
pub struct Trigger {
    pub event: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub schedule: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub pattern: Option<String>,
    pub line: u32,
}

#[derive(Serialize)]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub line: u32,
    pub jobs: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct Step {
    pub id: String,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub name: Option<String>,
    pub line: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub purpose: Option<&'static str>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub deploy_target: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub env_refs: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub secret_refs: Vec<String>,
}

#[derive(Serialize)]
pub struct Dependency {
    pub job: String,
    pub reason: &'static str,
}

#[derive(Serialize, Default)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub line: u32,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub needs: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub requires: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub rules: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub env_refs: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub secret_refs: Vec<String>,
    #[serde(skip_serializing_if = "crate::facts_cache::empty")]
    pub depends_on: Vec<Dependency>,
    pub steps: Vec<Step>,
}

#[derive(Serialize)]
pub struct Pipeline {
    pub id: String,
    pub name: String,
    pub provider: &'static str,
    pub file: u32,
    pub line: u32,
    pub triggers: Vec<Trigger>,
    pub stages: Vec<Stage>,
    pub jobs: Vec<Job>,
}

pub struct Builder<'a> {
    path: &'a str,
    provider: &'static str,
    file: u32,
    id: String,
    triggers: Vec<Trigger>,
    stages: Vec<Stage>,
    jobs: Vec<Job>,
}

pub fn extract(root: &Path, paths: &[&str]) -> Vec<Pipeline> {
    paths
        .iter()
        .enumerate()
        .filter_map(|(file, path)| {
            let detected = tables::detect(path)?;
            let held = crate::paths::kept_inside(root, Path::new(path))?;
            if std::fs::metadata(held).ok()?.len() > LARGEST_SOURCE {
                return None;
            }
            let source = crate::paths::read_inside(root, path)?;
            let mut builder = Builder::new(path, detected.provider, file as u32);
            match detected.layout {
                "jenkins" => jenkins::read(&mut builder, &source),
                layout => builder.read_yaml(layout, &Value::parse(&source)?),
            }
            Some(builder.finish(&source))
        })
        .collect()
}

fn unique<T: Ord>(mut held: Vec<T>) -> Vec<T> {
    held.sort();
    held.dedup();
    held
}

fn captured(pattern: &regex::Regex, text: &str) -> Vec<String> {
    pattern
        .captures_iter(text)
        .filter_map(|found| found.get(1).map(|group| group.as_str().to_string()))
        .collect()
}

fn references(text: &str) -> (Vec<String>, Vec<String>) {
    let mut env = Vec::new();
    let mut secret = Vec::new();
    for (kind, pattern) in tables::references() {
        match *kind {
            "secret" => secret.extend(captured(pattern, text)),
            _ => env.extend(captured(pattern, text)),
        }
    }
    let secret = unique(secret);
    let env = unique(env).into_iter().filter(|name| !secret.contains(name)).collect();
    (env, secret)
}

fn refs_of(value: &Value) -> (Vec<String>, Vec<String>) {
    let mut strings = Vec::new();
    value.strings(&mut strings);
    references(&strings.join("\n"))
}

fn text_of(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match &value.kind {
        Kind::Text(held) => Some(held.clone()),
        Kind::Map(_) => text_of(value.get("name")),
        Kind::Seq(_) => None,
    }
    .filter(|held| !held.is_empty())
}

fn command_of(value: &Value) -> Option<String> {
    match &value.kind {
        Kind::Text(held) => Some(held.trim().to_string()),
        Kind::Seq(items) => Some(items.iter().filter_map(command_of).collect::<Vec<_>>().join("\n")),
        Kind::Map(_) => value.get_any(tables::keys("command")).and_then(command_of),
    }
    .filter(|held| !held.is_empty())
}

impl<'a> Builder<'a> {
    pub fn new(path: &'a str, provider: &'static str, file: u32) -> Self {
        Builder {
            path,
            provider,
            file,
            id: format!("ci:{path}"),
            triggers: Vec::new(),
            stages: Vec::new(),
            jobs: Vec::new(),
        }
    }

    fn finish(mut self, source: &str) -> Pipeline {
        self.resolve();
        let name = Value::parse(source)
            .and_then(|root| text_of(root.get("name")))
            .unwrap_or_else(|| self.path.rsplit('/').next().unwrap_or(self.path).to_string());
        Pipeline {
            id: self.id,
            name,
            provider: self.provider,
            file: self.file,
            line: 1,
            triggers: self.triggers,
            stages: self.stages,
            jobs: self.jobs,
        }
    }

    fn resolve(&mut self) {
        let ids: Vec<(String, String)> = self.jobs.iter().map(|job| (job.name.clone(), job.id.clone())).collect();
        let order: Vec<String> = self.stages.iter().map(|stage| stage.name.clone()).collect();
        for at in 0..self.jobs.len() {
            let mut found: Vec<Dependency> = Vec::new();
            let explicit: Vec<(&String, &'static str)> = self.jobs[at]
                .needs
                .iter()
                .map(|name| (name, "needs"))
                .chain(self.jobs[at].requires.iter().map(|name| (name, "requires")))
                .collect();
            for (name, reason) in &explicit {
                if let Some((_, id)) = ids.iter().find(|(held, _)| held == *name) {
                    found.push(Dependency { job: id.clone(), reason });
                }
            }
            if explicit.is_empty() && let Some(stage) = self.jobs[at].stage.clone()
                && let Some(position) = order.iter().position(|held| *held == stage)
                && position > 0
            {
                let previous = &order[position - 1];
                for other in &self.jobs {
                    if other.stage.as_deref() == Some(previous.as_str()) {
                        found.push(Dependency { job: other.id.clone(), reason: "stage" });
                    }
                }
            }
            self.jobs[at].depends_on = found;
        }
        for stage in &mut self.stages {
            stage.jobs = self
                .jobs
                .iter()
                .filter(|job| job.stage.as_deref() == Some(stage.name.as_str()))
                .map(|job| job.id.clone())
                .collect();
        }
    }

    fn read_yaml(&mut self, layout: &str, root: &Value) {
        match layout {
            "jobs_map" => self.jobs_map(root),
            "top_level_jobs" => self.top_level_jobs(root),
            "staged_jobs" => self.staged_jobs(root),
            "sectioned_steps" => self.sectioned_steps(root),
            "job_list" => self.job_list(root),
            _ => self.single_job(root),
        }
        self.read_triggers(root);
    }

    fn stage(&mut self, name: &str, line: u32) {
        if self.stages.iter().all(|stage| stage.name != name) {
            self.stages.push(Stage { id: format!("{}#stage:{name}", self.id), name: name.to_string(), line, jobs: Vec::new() });
        }
    }

    pub fn add_job(&mut self, name: &str, line: u32, value: &Value, stage: Option<String>) -> usize {
        let mut id = format!("{}#job:{name}", self.id);
        if self.jobs.iter().any(|job| job.id == id) {
            id = format!("{id}#{}", self.jobs.len());
        }
        let environment = text_of(value.get_any(tables::keys("environment")));
        let steps = self.steps_of(value, &id, environment.as_deref());
        let (env_refs, secret_refs) = refs_of(value);
        let rules = tables::keys("rules")
            .iter()
            .filter_map(|key| value.get(key).map(|held| format!("{key}: {}", held.brief())))
            .collect();
        if let Some(stage) = &stage {
            self.stage(stage, line);
        }
        self.jobs.push(Job {
            id,
            name: name.to_string(),
            line,
            stage,
            environment,
            needs: value.get_any(tables::keys("needs")).map(Value::names).unwrap_or_default(),
            requires: value.get_any(tables::keys("requires")).map(Value::names).unwrap_or_default(),
            rules,
            env_refs,
            secret_refs,
            depends_on: Vec::new(),
            steps,
        });
        self.jobs.len() - 1
    }

    pub fn add_plain_job(&mut self, name: &str, line: u32, stage: Option<String>, steps: Vec<Step>) {
        let mut id = format!("{}#job:{name}", self.id);
        if self.jobs.iter().any(|job| job.id == id) {
            id = format!("{id}#{}", self.jobs.len());
        }
        let steps = steps
            .into_iter()
            .enumerate()
            .map(|(at, mut step)| {
                step.id = format!("{id}#step:{at}");
                step
            })
            .collect();
        if let Some(stage) = &stage {
            self.stage(stage, line);
        }
        self.jobs.push(Job { id, name: name.to_string(), line, stage, steps, ..Job::default() });
    }

    fn steps_of(&self, value: &Value, job_id: &str, environment: Option<&str>) -> Vec<Step> {
        let step_keys = tables::keys("steps");
        let forced = tables::keys("deploy_section");
        let mut steps: Vec<Step> = Vec::new();
        for (key, held) in value.entries() {
            if !step_keys.contains(&key.as_str()) {
                continue;
            }
            let deploying = forced.contains(&key.as_str());
            match &held.kind {
                Kind::Seq(items) => items.iter().for_each(|item| steps.push(step_from(item, deploying, environment))),
                _ => steps.push(step_from(held, deploying, environment)),
            }
        }
        if steps.is_empty()
            && let Some(nested) = value.find_deep("steps")
        {
            nested.items().iter().for_each(|item| steps.push(step_from(item, false, environment)));
        }
        for (at, step) in steps.iter_mut().enumerate() {
            step.id = format!("{job_id}#step:{at}");
        }
        steps
    }

    fn jobs_map(&mut self, root: &Value) {
        if let Some(jobs) = root.get("jobs") {
            for (name, job) in jobs.entries() {
                if matches!(job.kind, Kind::Map(_)) {
                    self.add_job(name, job.line, job, None);
                }
            }
        }
        if self.provider == "circleci" {
            self.circleci_workflows(root);
        }
    }

    fn circleci_workflows(&mut self, root: &Value) {
        let Some(workflows) = root.get("workflows") else { return };
        for (_, workflow) in workflows.entries() {
            for item in workflow.get("jobs").map(Value::items).unwrap_or_default() {
                for (name, detail) in item.entries() {
                    let required = detail.get("requires").map(Value::names).unwrap_or_default();
                    if let Some(job) = self.jobs.iter_mut().find(|job| job.name == *name) {
                        for needed in required {
                            if !job.requires.contains(&needed) {
                                job.requires.push(needed);
                            }
                        }
                    }
                }
            }
            for trigger in workflow.get("triggers").map(Value::items).unwrap_or_default() {
                if let Some(cron) = trigger.get("schedule").and_then(|held| held.get("cron")).and_then(Value::text) {
                    self.triggers.push(schedule_trigger(cron, trigger.line));
                }
            }
        }
    }

    fn top_level_jobs(&mut self, root: &Value) {
        let reserved = tables::keys("reserved");
        let step_keys = tables::keys("steps");
        for name in root.get("stages").map(Value::names).unwrap_or_default() {
            self.stage(&name, root.get("stages").map_or(1, |held| held.line));
        }
        for (name, job) in root.entries() {
            let runnable = job.entries().iter().any(|(key, _)| {
                step_keys.contains(&key.as_str()) || key == "trigger" || key == "extends"
            });
            if reserved.contains(&name.as_str()) || name.starts_with('.') || !runnable {
                continue;
            }
            let stage = text_of(job.get("stage")).or_else(|| Some("test".to_string()));
            self.add_job(name, job.line, job, stage);
        }
    }

    fn staged_jobs(&mut self, root: &Value) {
        if let Some(stages) = root.get("stages") {
            for item in stages.items() {
                let Some(name) = item.get("stage").and_then(|held| held.names().into_iter().next()) else { continue };
                self.stage(&name, item.line);
                for job in item.get("jobs").map(Value::items).unwrap_or_default() {
                    self.azure_job(job, Some(name.clone()));
                }
            }
        } else if let Some(jobs) = root.get("jobs") {
            for job in jobs.items() {
                self.azure_job(job, None);
            }
        } else if root.get("steps").is_some() {
            self.add_job("build", root.line, root, None);
        }
    }

    fn azure_job(&mut self, job: &Value, stage: Option<String>) {
        let identity = tables::keys("identity");
        let found = identity
            .iter()
            .filter(|key| **key != "stage" && **key != "step")
            .find_map(|key| job.get(key).and_then(|held| held.names().into_iter().next()));
        if let Some(name) = found {
            self.add_job(&name, job.line, job, stage);
        }
    }

    fn sectioned_steps(&mut self, root: &Value) {
        let Some(pipelines) = root.get("pipelines") else { return };
        for (section, held) in pipelines.entries() {
            match &held.kind {
                Kind::Seq(items) => self.bitbucket_list(section, items),
                Kind::Map(entries) => {
                    for (_, list) in entries {
                        self.bitbucket_list(section, list.items());
                    }
                }
                Kind::Text(_) => {}
            }
        }
    }

    fn bitbucket_list(&mut self, section: &str, items: &[Value]) {
        let mut previous: Option<String> = None;
        for item in items {
            let steps: Vec<&Value> = match item.get("parallel") {
                Some(parallel) => parallel.items().iter().filter_map(|held| held.get("step")).collect(),
                None => match item.get("stage").and_then(|held| held.get("steps")) {
                    Some(staged) => staged.items().iter().filter_map(|held| held.get("step")).collect(),
                    None => item.get("step").into_iter().collect(),
                },
            };
            let parallel = item.get("parallel").is_some();
            let mut produced = Vec::new();
            for step in steps {
                let mut name = text_of(step.get("name")).unwrap_or_else(|| format!("step {}", self.jobs.len() + 1));
                if self.jobs.iter().any(|job| job.name == name) {
                    name = format!("{name} [{section}]");
                }
                let at = self.add_job(&name, step.line, step, None);
                if let Some(deployment) = text_of(step.get("deployment")) {
                    self.jobs[at].environment = Some(deployment.clone());
                    self.retarget(at, &deployment);
                }
                if let Some(held) = &previous {
                    self.jobs[at].needs.push(held.clone());
                }
                produced.push(name);
            }
            if !parallel || !produced.is_empty() {
                previous = produced.last().cloned().filter(|_| !parallel).or(previous);
            }
        }
    }

    fn retarget(&mut self, at: usize, target: &str) {
        for step in &mut self.jobs[at].steps {
            if step.purpose == Some("deploy") && step.deploy_target.is_none() {
                step.deploy_target = Some(target.to_string());
            }
        }
    }

    fn job_list(&mut self, root: &Value) {
        let mut group: Vec<String> = Vec::new();
        let mut barrier: Vec<String> = Vec::new();
        for item in root.get("steps").map(Value::items).unwrap_or_default() {
            let waiting = item.text() == Some("wait") || item.get("wait").is_some() || item.get("block").is_some();
            if waiting {
                barrier = std::mem::take(&mut group);
                continue;
            }
            if !matches!(item.kind, Kind::Map(_)) {
                continue;
            }
            let name = text_of(item.get_any(tables::keys("name")))
                .or_else(|| item.get_any(tables::keys("command")).and_then(command_of))
                .unwrap_or_else(|| format!("step {}", self.jobs.len() + 1));
            let at = self.add_job(&name, item.line, item, None);
            let environment = self.jobs[at].environment.clone();
            let own = step_from(item, false, environment.as_deref());
            if self.jobs[at].steps.is_empty() {
                let mut own = own;
                own.id = format!("{}#step:0", self.jobs[at].id);
                self.jobs[at].steps.push(own);
            }
            for before in &barrier {
                if !self.jobs[at].needs.contains(before) {
                    self.jobs[at].needs.push(before.clone());
                }
            }
            group.push(name);
        }
    }

    fn single_job(&mut self, root: &Value) {
        self.add_job("build", root.line, root, None);
    }

    fn read_triggers(&mut self, root: &Value) {
        let rows = tables::triggers(self.provider);
        let ref_keys: Vec<&str> = rows.iter().filter(|row| row.mode == "ref_keys").flat_map(|row| row.key.split(',')).collect();
        let schedule_keys: Vec<&str> =
            rows.iter().filter(|row| row.mode == "schedule_keys").flat_map(|row| row.key.split(',')).collect();
        for row in &rows {
            match row.mode {
                "events" => {
                    if let Some(held) = root.get(row.key) {
                        self.event_triggers(held, &ref_keys, &schedule_keys);
                    }
                }
                "event" => {
                    if let Some(held) = root.get(row.key)
                        && held.text() != Some("none")
                    {
                        self.triggers.push(Trigger {
                            event: row.event.to_string(),
                            kind: "event",
                            pattern: Some(held.brief()).filter(|text| !text.is_empty()),
                            line: held.line,
                            ..Trigger::default()
                        });
                    }
                }
                "schedule" => {
                    for item in root.get(row.key).map(Value::items).unwrap_or_default() {
                        if let Some(cron) = item.get_any(&schedule_keys).and_then(Value::text) {
                            self.triggers.push(schedule_trigger(cron, item.line));
                        }
                    }
                }
                "section" => {
                    if let Some(held) = root.get("pipelines").and_then(|pipelines| pipelines.get(row.key)) {
                        let names = match &held.kind {
                            Kind::Map(entries) => entries.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>().join(", "),
                            _ => String::new(),
                        };
                        self.triggers.push(Trigger {
                            event: row.event.to_string(),
                            kind: "event",
                            pattern: Some(names).filter(|text| !text.is_empty()),
                            line: held.line,
                            ..Trigger::default()
                        });
                    }
                }
                "rule_pattern" => {
                    if let Ok(pattern) = regex::Regex::new(row.key) {
                        let mut strings = Vec::new();
                        root.strings(&mut strings);
                        for event in unique(captured(&pattern, &strings.join("\n"))) {
                            let kind = if event == "schedule" { "schedule" } else { "event" };
                            self.triggers.push(Trigger { event, kind, line: 1, ..Trigger::default() });
                        }
                    }
                }
                _ => {}
            }
        }
        if self.triggers.is_empty()
            && let Some(row) = rows.iter().find(|row| row.mode == "default")
        {
            self.triggers.push(Trigger { event: row.event.to_string(), kind: "event", line: 1, ..Trigger::default() });
        }
    }

    pub fn jobs_mut(&mut self) -> &mut Vec<Job> {
        &mut self.jobs
    }

    pub fn add_trigger(&mut self, trigger: Trigger) {
        self.triggers.push(trigger);
    }

    fn event_triggers(&mut self, held: &Value, ref_keys: &[&str], schedule_keys: &[&str]) {
        match &held.kind {
            Kind::Text(event) => self.triggers.push(Trigger { event: event.clone(), kind: "event", line: held.line, ..Trigger::default() }),
            Kind::Seq(items) => {
                for item in items {
                    if let Some(event) = item.text() {
                        self.triggers.push(Trigger { event: event.to_string(), kind: "event", line: item.line, ..Trigger::default() });
                    }
                }
            }
            Kind::Map(entries) => {
                for (event, detail) in entries {
                    let scheduled = detail.items().iter().filter_map(|item| item.get_any(schedule_keys).and_then(Value::text).map(|cron| (cron, item.line)));
                    let crons: Vec<(&str, u32)> = scheduled.collect();
                    if !crons.is_empty() {
                        for (cron, line) in crons {
                            self.triggers.push(schedule_trigger(cron, line));
                        }
                        continue;
                    }
                    let pattern = ref_keys
                        .iter()
                        .filter_map(|key| detail.get(key).map(|found| format!("{key}: {}", found.brief())))
                        .collect::<Vec<_>>()
                        .join("; ");
                    self.triggers.push(Trigger {
                        event: event.clone(),
                        kind: "event",
                        pattern: Some(pattern).filter(|text| !text.is_empty()),
                        line: detail.line,
                        ..Trigger::default()
                    });
                }
            }
        }
    }
}

fn schedule_trigger(cron: &str, line: u32) -> Trigger {
    Trigger { event: "schedule".to_string(), kind: "schedule", schedule: Some(cron.to_string()), pattern: None, line }
}

pub fn step_from(item: &Value, deploying: bool, environment: Option<&str>) -> Step {
    let mut step = Step { line: item.line, ..Step::default() };
    match &item.kind {
        Kind::Text(held) => step.command = Some(held.trim().to_string()).filter(|text| !text.is_empty()),
        Kind::Map(entries) => {
            step.name = text_of(item.get_any(tables::keys("name")));
            step.command = item.get_any(tables::keys("command")).and_then(command_of);
            if step.name.is_none()
                && let Some(Kind::Map(_)) = item.get_any(tables::keys("command")).map(|held| &held.kind)
            {
                step.name = item.get_any(tables::keys("command")).and_then(|held| text_of(held.get("name")));
            }
            step.action = item
                .get_any(tables::keys("action"))
                .and_then(|held| text_of(Some(held)));
            if step.action.is_none() && step.command.is_none() && step.name.is_none() {
                step.action = entries.first().map(|(key, _)| key.clone());
            }
        }
        Kind::Seq(_) => step.command = command_of(item),
    }
    let (env_refs, secret_refs) = refs_of(item);
    step.env_refs = env_refs;
    step.secret_refs = secret_refs;
    classify(&mut step, deploying, environment);
    step
}

pub fn classify(step: &mut Step, deploying: bool, environment: Option<&str>) {
    let mut purpose: Option<&'static str> = None;
    if let Some(command) = &step.command {
        'rows: for row in tables::commands() {
            for line in command.lines() {
                if row.pattern.is_match(line) {
                    purpose = Some(row.kind);
                    step.deploy_target = row.target.as_ref().and_then(|found| captured(found, line).into_iter().next());
                    step.paths = row.paths.as_ref().map(|found| captured(found, line)).unwrap_or_default();
                    break 'rows;
                }
            }
        }
    } else if let Some(action) = &step.action {
        let name = action.split('@').next().unwrap_or(action).to_ascii_lowercase();
        purpose = tables::actions().iter().find(|(_, prefix)| name.starts_with(prefix.as_str())).map(|(kind, _)| *kind);
    }
    if deploying {
        purpose = Some("deploy");
    }
    if purpose == Some("deploy") && step.deploy_target.is_none() {
        step.deploy_target = environment.map(str::to_string);
    }
    step.purpose = purpose;
}
