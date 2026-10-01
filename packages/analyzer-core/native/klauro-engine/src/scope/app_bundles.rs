use super::{beside, dependency_names, Candidate, Declaration, Declares, Files};
use crate::model::CallFact;
use crate::paths::{directory_of, display_name, is_not_shipped, is_test, join};

type Provider = fn(&Files, &str, &str, &[CallFact], u32) -> Option<Candidate>;

static PROVIDERS: &[Provider] = &[
    tauri,
    electron_builder_file,
    electron_builder_key,
    electron_forge,
    packaged_executable_key,
    capacitor,
    cordova,
    expo_build,
    expo_application,
    flutter,
    pyinstaller,
    briefcase,
    windows_installer,
    jpackage,
];

static ELECTRON_BUILDER_EXTENSIONS: &[&str] =
    &["cjs", "js", "json", "json5", "mjs", "toml", "ts", "yaml", "yml"];
static ELECTRON_BUILDER_KEYS: &[&str] =
    &["appId", "productName", "mac", "win", "linux", "nsis", "dmg", "directories", "extraResources"];
static ELECTRON_DEPENDENCIES: &[&str] = &["electron", "@electron-forge/cli"];
static FORGE_CONFIG_EXTENSIONS: &[&str] = &["cjs", "js", "mjs", "ts"];
static PACKAGED_EXECUTABLE_KEYS: &[&str] = &["targets", "assets", "outputPath", "scripts"];
static CAPACITOR_EXTENSIONS: &[&str] = &["cjs", "js", "json", "mjs", "ts"];
static FLUTTER_PLATFORMS: &[&str] = &["android", "ios", "linux", "macos", "windows"];
static PYINSTALLER_CALLS: &[&str] = &["Analysis", "EXE", "PYZ"];
static WINDOWS_INSTALLER_SUFFIXES: &[&str] = &[".appinstaller", ".appxmanifest", ".wapproj", ".wixproj", ".wxs"];
static JPACKAGE_PLUGINS: &[&str] = &["org.beryx.jlink", "org.beryx.runtime", "org.panteleyev.jpackageplugin"];

pub(super) fn detect(files: &Files, path: &str, calls: &[CallFact], file: u32) -> Vec<Candidate> {
    if is_test(path) || is_not_shipped(path) {
        return Vec::new();
    }
    let basename = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    PROVIDERS
        .iter()
        .filter_map(|provider| provider(files, path, &basename, calls, file))
        .collect()
}

fn declared(path: &str, kind: &'static str, ships: Vec<String>) -> Candidate {
    let root = directory_of(path).to_string();
    Candidate {
        name: display_name(&root),
        root,
        declarations: vec![Declaration { declares: Declares::Ship, kind, at: path.to_string() }],
        ships,
        runs: None,
    }
}

fn value_of<'a>(files: &Files<'a>, parent: &str, name: &str) -> Option<&'a str> {
    files.child(parent, name)?.type_annotation.as_deref().map(super::unquote)
}

fn is_on(files: &Files, parent: &str, name: &str) -> bool {
    value_of(files, parent, name).is_some_and(|said| said.eq_ignore_ascii_case("true"))
}

fn local_path(root: &str, value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.contains("://")).then(|| beside(root, value))
}

fn tauri(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "tauri.conf.json" {
        return None;
    }
    let document = files.of(path)?;
    let version_two = document.iter().find(|node| node.name == "bundle").copied();
    let version_one = document
        .iter()
        .find(|node| node.name == "tauri")
        .and_then(|section| files.child(&section.id, "bundle"));
    let bundle = version_two.or(version_one)?;
    if !is_on(files, &bundle.id, "active") {
        return None;
    }
    let root = directory_of(path);
    let frontend = document
        .iter()
        .find(|node| node.name == "build")
        .and_then(|build| {
            value_of(files, &build.id, "frontendDist").or_else(|| value_of(files, &build.id, "distDir"))
        })
        .and_then(|value| local_path(root, value))
        .into_iter()
        .collect();
    Some(declared(path, "tauri-bundle", frontend))
}

fn electron_builder_file(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    let (stem, extension) = basename.rsplit_once('.')?;
    let sibling_manifest = files.exists(&join(directory_of(path), "package.json"));
    (stem == "electron-builder" && ELECTRON_BUILDER_EXTENSIONS.contains(&extension) && sibling_manifest)
        .then(|| declared(path, "electron-builder", Vec::new()))
}

fn electron_builder_key(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "package.json" {
        return None;
    }
    let build = files.of(path)?.iter().find(|node| node.name == "build")?;
    let members = files.of(&build.id)?;
    members
        .iter()
        .any(|member| ELECTRON_BUILDER_KEYS.contains(&member.name.as_str()))
        .then(|| declared(path, "electron-builder", Vec::new()))
}

fn electron_forge(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "package.json" {
        return None;
    }
    let root = directory_of(path);
    let names_forge = files
        .of(path)?
        .iter()
        .find(|node| node.name == "config")
        .is_some_and(|config| files.child(&config.id, "forge").is_some());
    let config_file = FORGE_CONFIG_EXTENSIONS
        .iter()
        .any(|extension| files.exists(&join(root, &format!("forge.config.{extension}"))));
    let uses_electron = dependency_names(files, path)
        .iter()
        .any(|name| ELECTRON_DEPENDENCIES.contains(&name.as_str()));
    ((names_forge || config_file) && uses_electron).then(|| declared(path, "electron-forge", Vec::new()))
}

fn packaged_executable_key(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "package.json" {
        return None;
    }
    let packaging = files.of(path)?.iter().find(|node| node.name == "pkg")?;
    let root = directory_of(path);
    let members = files.of(&packaging.id)?;
    members.iter().any(|member| PACKAGED_EXECUTABLE_KEYS.contains(&member.name.as_str())).then(|| {
        let output = value_of(files, &packaging.id, "outputPath")
            .and_then(|value| local_path(root, value))
            .into_iter()
            .collect();
        declared(path, "pkg-executable", output)
    })
}

fn capacitor(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    let (stem, extension) = basename.rsplit_once('.')?;
    if stem != "capacitor.config" || !CAPACITOR_EXTENSIONS.contains(&extension) {
        return None;
    }
    let web = value_of(files, path, "webDir")
        .and_then(|value| local_path(directory_of(path), value))
        .into_iter()
        .collect();
    Some(declared(path, "capacitor", web))
}

fn cordova(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "config.xml" {
        return None;
    }
    let widget = files.of(path)?.iter().find(|node| node.name == "widget")?;
    files.child(&widget.id, "id")?;
    Some(declared(path, "cordova", Vec::new()))
}

fn expo_build(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "eas.json" {
        return None;
    }
    files.child(path, "build")?;
    Some(declared(path, "expo-build", Vec::new()))
}

fn expo_application(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "app.json" {
        return None;
    }
    let expo = files.child(path, "expo")?;
    let stores = ["android", "ios"].iter().any(|platform| {
        files.child(&expo.id, platform).is_some_and(|section| {
            files.child(&section.id, "package").is_some() || files.child(&section.id, "bundleIdentifier").is_some()
        })
    });
    stores.then(|| declared(path, "expo-application", Vec::new()))
}

fn flutter(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "pubspec.yaml" {
        return None;
    }
    let section = files.of(path)?.iter().find(|node| node.name == "flutter" && node.type_annotation.is_none())?;
    if files.descendants(&section.id).iter().any(|node| node.name == "plugin") {
        return None;
    }
    let root = directory_of(path);
    let has_runner = FLUTTER_PLATFORMS.iter().any(|platform| {
        let folder = join(root, platform);
        files.paths.iter().any(|other| crate::paths::contains(&folder, other) && *other != folder)
    });
    has_runner.then(|| declared(path, "flutter-application", Vec::new()))
}

fn pyinstaller(files: &Files, path: &str, basename: &str, calls: &[CallFact], file: u32) -> Option<Candidate> {
    if !basename.ends_with(".spec") {
        return None;
    }
    let in_file = || calls.iter().filter(|call| call.file == file);
    if !in_file().any(|call| PYINSTALLER_CALLS.contains(&call.callee.as_str())) {
        return None;
    }
    let root = directory_of(path);
    let mut scripts: Vec<String> = in_file()
        .filter(|call| call.callee == "Analysis")
        .flat_map(|call| call.literals.iter())
        .map(|literal| join(root, super::unquote(literal)))
        .filter(|candidate| files.exists(candidate))
        .collect();
    scripts.sort();
    scripts.dedup();
    Some(declared(path, "pyinstaller", scripts))
}

fn briefcase(files: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    if basename != "pyproject.toml" {
        return None;
    }
    let root = directory_of(path);
    let document = files.descendants(path);
    let apps: Vec<&str> = document
        .iter()
        .filter(|node| node.name.starts_with("tool.briefcase.app."))
        .map(|node| node.id.as_str())
        .collect();
    if apps.is_empty() {
        return None;
    }
    let mut sources: Vec<String> = document
        .iter()
        .filter(|node| node.name == "sources" && node.parent.as_deref().is_some_and(|parent| apps.contains(&parent)))
        .flat_map(|section| files.of(&section.id).into_iter().flatten())
        .map(|source| join(root, super::unquote(&source.name)))
        .filter(|candidate| files.holds(candidate))
        .collect();
    sources.sort();
    sources.dedup();
    Some(declared(path, "briefcase", sources))
}

fn windows_installer(_: &Files, path: &str, basename: &str, _: &[CallFact], _: u32) -> Option<Candidate> {
    WINDOWS_INSTALLER_SUFFIXES
        .iter()
        .any(|suffix| basename.ends_with(suffix))
        .then(|| declared(path, "windows-installer", Vec::new()))
}

fn jpackage(_: &Files, path: &str, basename: &str, calls: &[CallFact], file: u32) -> Option<Candidate> {
    if !basename.starts_with("build.gradle") {
        return None;
    }
    let applies = calls.iter().any(|call| {
        call.file == file
            && call.callee == "id"
            && call.literals.iter().any(|value| {
                let plugin = super::plugin_named(value);
                JPACKAGE_PLUGINS.contains(&plugin) || plugin.ends_with("jpackage")
            })
    });
    applies.then(|| declared(path, "jpackage", Vec::new()))
}
