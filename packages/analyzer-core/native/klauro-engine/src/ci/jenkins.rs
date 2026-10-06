use super::{Builder, Step, Trigger, classify, tables};

pub fn read(builder: &mut Builder, source: &str) {
    let Some(stage) = tables::jenkins("stage") else { return };
    let lines: Vec<&str> = source.lines().collect();
    let starts: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter_map(|(at, line)| stage.captures(line).map(|found| (at, found[1].to_string())))
        .collect();
    for (position, (start, name)) in starts.iter().enumerate() {
        let end = starts.get(position + 1).map(|(next, _)| *next).unwrap_or(lines.len());
        let region = lines[*start..end].join("\n");
        let environment = tables::jenkins("environment").and_then(|found| found.captures(&region)).map(|found| found[1].to_string());
        let steps = steps_of(&region, *start as u32 + 1, environment.as_deref());
        builder.add_plain_job(name, *start as u32 + 1, None, steps);
        if let Some(job) = builder.jobs_mut().last_mut() {
            job.environment = environment;
            if let Some(before) = position.checked_sub(1).and_then(|at| starts.get(at)) {
                job.needs.push(before.1.clone());
            }
        }
    }
    if let Some(cron) = tables::jenkins("trigger_cron") {
        for (at, line) in lines.iter().enumerate() {
            if let Some(found) = cron.captures(line) {
                builder.add_trigger(Trigger {
                    event: "schedule".to_string(),
                    kind: "schedule",
                    schedule: Some(found[1].to_string()),
                    line: at as u32 + 1,
                    ..Trigger::default()
                });
            }
        }
    }
    if let Some(event) = tables::jenkins("trigger_event") {
        for (at, line) in lines.iter().enumerate() {
            if let Some(found) = event.captures(line) {
                builder.add_trigger(Trigger {
                    event: found[1].to_string(),
                    kind: "event",
                    line: at as u32 + 1,
                    ..Trigger::default()
                });
            }
        }
    }
}

fn blocks(text: &str, opener: &regex::Regex) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    for hit in opener.find_iter(text) {
        let after = &text[hit.end()..];
        let quote = &text[hit.end().saturating_sub(3)..hit.end()];
        if let Some(close) = after.find(quote) {
            found.push((hit.start(), after[..close].to_string()));
        }
    }
    found
}

fn steps_of(region: &str, first_line: u32, environment: Option<&str>) -> Vec<Step> {
    let mut found: Vec<(usize, Step)> = Vec::new();
    if let Some(opener) = tables::jenkins("command") {
        for (at, body) in blocks(region, opener) {
            for line in body.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
                found.push((at, shell_step(line, first_line, environment)));
            }
        }
    }
    if let Some(single) = tables::jenkins("command_line") {
        for hit in single.captures_iter(region) {
            let at = hit.get(0).map_or(0, |whole| whole.start());
            if found.iter().all(|(held, _)| *held != at) {
                found.push((at, shell_step(hit[1].trim(), first_line, environment)));
            }
        }
    }
    if let Some(call) = tables::jenkins("step_call") {
        for hit in call.captures_iter(region) {
            let mut step = Step { action: Some(hit[1].to_string()), line: first_line, ..Step::default() };
            classify(&mut step, false, environment);
            found.push((hit.get(0).map_or(0, |whole| whole.start()), step));
        }
    }
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, step)| step).collect()
}

fn shell_step(command: &str, line: u32, environment: Option<&str>) -> Step {
    let mut step = Step { command: Some(command.to_string()), line, ..Step::default() };
    let (env_refs, secret_refs) = super::references(command);
    step.env_refs = env_refs;
    step.secret_refs = secret_refs;
    classify(&mut step, false, environment);
    step
}
