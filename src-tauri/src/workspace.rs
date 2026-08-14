use crate::repository::{self, RepositoryError, RepositoryInfo};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub name: String,
    pub path: String,
}

pub fn open(path: &str) -> Result<Vec<WorkspaceProject>, RepositoryError> {
    let selected_path = Path::new(path);
    if !selected_path.is_dir() {
        return Err(RepositoryError::new(
            "Choose a folder that contains your Git project folders.",
        ));
    }

    let workspace_root = fs::canonicalize(selected_path).map_err(|error| {
        RepositoryError::new(format!("Could not read the workspace folder: {error}"))
    })?;
    let mut projects = Vec::new();
    let mut seen_roots = HashSet::new();

    for entry in fs::read_dir(&workspace_root).map_err(|error| {
        RepositoryError::new(format!("Could not list the workspace folder: {error}"))
    })? {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }

        let Ok(candidate) = fs::canonicalize(entry.path()) else {
            continue;
        };
        if candidate.parent() != Some(workspace_root.as_path()) {
            continue;
        }
        let Ok(has_git_marker) = candidate.join(".git").try_exists() else {
            continue;
        };
        if !has_git_marker || !seen_roots.insert(candidate.clone()) {
            continue;
        }

        let Some(path) = candidate.to_str() else {
            continue;
        };
        projects.push(WorkspaceProject {
            name: display_name(&candidate),
            path: path.to_owned(),
        });
    }

    projects.sort_by(|left, right| left.path.cmp(&right.path));
    if projects.is_empty() {
        return Err(RepositoryError::new(
            "No Git repositories were found in the workspace's immediate child folders.",
        ));
    }

    Ok(projects)
}

pub fn open_project(path: &str) -> Result<RepositoryInfo, RepositoryError> {
    let selected_root = fs::canonicalize(path).map_err(|error| {
        RepositoryError::new(format!("Could not resolve the workspace project: {error}"))
    })?;
    let repository = repository::open(path)?;
    let resolved_root = fs::canonicalize(&repository.path).map_err(|error| {
        RepositoryError::new(format!("Could not resolve the Git working tree: {error}"))
    })?;
    if resolved_root != selected_root {
        return Err(RepositoryError::new(format!(
            "Workspace folder '{}' does not own its Git working tree.",
            display_name(&selected_root)
        )));
    }
    Ok(repository)
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Repository")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn discovers_direct_child_repositories_without_requiring_a_git_workspace_root() {
        let fixture = WorkspaceFixture::new();
        fixture.create_repository("web");
        fixture.create_repository("api");
        fs::create_dir(fixture.path.join("notes")).unwrap();

        let projects = open(fixture.path.to_str().unwrap()).unwrap();

        assert!(!fixture.path.join(".git").exists());
        assert_eq!(
            projects
                .iter()
                .map(|project| project.name.as_str())
                .collect::<Vec<_>>(),
            vec!["api", "web"]
        );
    }

    #[test]
    fn ignores_the_workspace_repository_and_nested_non_root_folders() {
        let fixture = WorkspaceFixture::new();
        fixture.init_repository(&fixture.path);
        fs::create_dir_all(fixture.path.join("ordinary/nested")).unwrap();
        fixture.create_repository("project");

        let projects = open(fixture.path.to_str().unwrap()).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "project");
    }

    #[test]
    fn a_malformed_project_does_not_block_valid_siblings() {
        let fixture = WorkspaceFixture::new();
        fixture.create_repository("valid");
        fs::create_dir(fixture.path.join("broken")).unwrap();
        fs::write(fixture.path.join("broken/.git"), "not a gitdir").unwrap();

        let projects = open(fixture.path.to_str().unwrap()).unwrap();

        assert_eq!(
            projects
                .iter()
                .map(|project| project.name.as_str())
                .collect::<Vec<_>>(),
            vec!["broken", "valid"]
        );
    }

    #[test]
    fn refuses_a_child_that_resolves_to_the_workspace_repository() {
        let fixture = WorkspaceFixture::new();
        fixture.init_repository(&fixture.path);
        let child = fixture.path.join("imposter");
        fs::create_dir(&child).unwrap();
        fs::write(child.join(".git"), "gitdir: ../.git\n").unwrap();
        git(
            &fixture.path,
            ["config", "core.worktree", fixture.path.to_str().unwrap()],
        );

        let error = open_project(child.to_str().unwrap()).unwrap_err();

        assert!(error
            .to_string()
            .contains("does not own its Git working tree"));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_repositories_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let fixture = WorkspaceFixture::new();
        fixture.create_repository("inside");
        let external = WorkspaceFixture::new();
        external.init_repository(&external.path);
        symlink(&external.path, fixture.path.join("outside-link")).unwrap();

        let projects = open(fixture.path.to_str().unwrap()).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "inside");
    }

    // macOS rejects invalid UTF-8 filenames before discovery; exercise this path on Unix
    // filesystems that permit them.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn a_non_utf8_project_path_does_not_block_valid_siblings() {
        use std::os::unix::ffi::OsStringExt;

        let fixture = WorkspaceFixture::new();
        fixture.create_repository("valid");
        let invalid_name = std::ffi::OsString::from_vec(vec![b'i', b'n', b'v', 0x80]);
        let invalid_path = fixture.path.join(invalid_name);
        fs::create_dir(&invalid_path).unwrap();
        fixture.init_repository(&invalid_path);

        let projects = open(fixture.path.to_str().unwrap()).unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "valid");
    }

    #[test]
    fn reports_a_workspace_without_direct_child_repositories() {
        let fixture = WorkspaceFixture::new();
        fs::create_dir(fixture.path.join("documents")).unwrap();

        let error = open(fixture.path.to_str().unwrap()).unwrap_err();

        assert!(error.to_string().contains("immediate child folders"));
    }

    struct WorkspaceFixture {
        path: PathBuf,
    }

    impl WorkspaceFixture {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let fixture_id = NEXT_WORKSPACE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "branch-diff-workspace-{}-{suffix}-{fixture_id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn create_repository(&self, name: &str) {
            let path = self.path.join(name);
            fs::create_dir(&path).unwrap();
            self.init_repository(&path);
        }

        fn init_repository(&self, path: &Path) {
            git(path, ["init", "--quiet"]);
            git(path, ["config", "user.name", "Branch Diff Tests"]);
            git(path, ["config", "user.email", "tests@example.invalid"]);
        }
    }

    impl Drop for WorkspaceFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git<I, S>(path: &Path, args: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = Command::new("git")
            .arg("--literal-pathspecs")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
