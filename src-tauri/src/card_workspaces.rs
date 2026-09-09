use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardWorkspace {
    pub repository_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_branch: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
}

pub fn list_worktrees(repository_path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repository = repository_root(repository_path)?;
    let output = git(&repository, &["worktree", "list", "--porcelain", "-z"])?;
    ensure_success(output, "list Git worktrees").and_then(parse_worktrees)
}

pub fn create_worktree(
    repository_path: &str,
    managed_root: &Path,
    card_id: &str,
    base_branch: &str,
    existing_branch: Option<&str>,
) -> Result<CardWorkspace, String> {
    let repository = repository_root(repository_path)?;
    validate_local_branch(&repository, base_branch, "base branch")?;
    let common_dir = common_git_dir(&repository)?;
    let scope = short_hash(&common_dir.to_string_lossy());
    let card_slug = slug(card_id)?;
    let card_hash = short_hash(card_id);
    let branch = match existing_branch {
        Some(branch) => {
            validate_local_branch(&repository, branch, "branch")?;
            branch.to_string()
        }
        None => format!(
            "patchdeck/{card_slug}-{}-{}",
            &scope[..10],
            &card_hash[..10]
        ),
    };
    validate_branch_name(&repository, &branch, "branch")?;

    let worktree = managed_root
        .join(&scope[..16])
        .join(format!("{card_slug}-{}", &card_hash[..10]));
    if worktree.exists() {
        return workspace_if_matching(&repository, &worktree, &branch, base_branch);
    }
    if let Some(parent) = worktree.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the managed worktree directory: {error}"))?;
    }

    let worktree_text = path_text(&worktree, "managed worktree")?;
    let output = if existing_branch.is_some() {
        git_worktree_add(&repository, &["worktree", "add", worktree_text, &branch])?
    } else {
        if local_branch_exists(&repository, &branch)? {
            return Err(format!(
                "The generated branch `{branch}` already exists, but its managed worktree is missing. Choose an existing branch explicitly or use a different card ID."
            ));
        }
        git_worktree_add(
            &repository,
            &["worktree", "add", "-b", &branch, worktree_text, base_branch],
        )?
    };
    ensure_success(output, "create the card worktree")?;
    workspace_if_matching(&repository, &worktree, &branch, base_branch)
}

pub fn attach_worktree(
    repository_path: &str,
    worktree_path: &str,
    base_branch: &str,
) -> Result<CardWorkspace, String> {
    let repository = repository_root(repository_path)?;
    validate_local_branch(&repository, base_branch, "base branch")?;
    let worktree = repository_root(worktree_path)?;
    if common_git_dir(&repository)? != common_git_dir(&worktree)? {
        return Err("The selected worktree belongs to a different Git repository.".to_string());
    }
    let branch = current_branch(&worktree)?;
    Ok(CardWorkspace {
        repository_path: path_text(&repository, "repository")?.to_string(),
        worktree_path: path_text(&worktree, "worktree")?.to_string(),
        branch,
        base_branch: base_branch.to_string(),
    })
}

fn workspace_if_matching(
    repository: &Path,
    worktree: &Path,
    branch: &str,
    base_branch: &str,
) -> Result<CardWorkspace, String> {
    let attached = attach_worktree(
        path_text(repository, "repository")?,
        path_text(worktree, "worktree")?,
        base_branch,
    )?;
    if attached.branch != branch {
        return Err(format!(
            "The managed worktree already exists on branch `{}`, expected `{branch}`.",
            attached.branch
        ));
    }
    Ok(attached)
}

fn repository_root(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || !Path::new(path).is_absolute() {
        return Err("The repository path must be absolute.".to_string());
    }
    let selected = std::fs::canonicalize(path)
        .map_err(|error| format!("Could not open the Git working tree at `{path}`: {error}"))?;
    let output = git(&selected, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(git_text(output, "find the Git working-tree root")?);
    let root = std::fs::canonicalize(&root)
        .map_err(|error| format!("Could not resolve the Git working-tree root: {error}"))?;
    if selected != root {
        return Err(format!(
            "Select the exact Git working-tree root `{}`.",
            root.display()
        ));
    }
    Ok(root)
}

fn common_git_dir(repository: &Path) -> Result<PathBuf, String> {
    let value = git_text(
        git(repository, &["rev-parse", "--git-common-dir"])?,
        "find the shared Git directory",
    )?;
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        repository.join(path)
    };
    std::fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve the shared Git directory: {error}"))
}

fn current_branch(repository: &Path) -> Result<String, String> {
    let branch = git_text(
        git(repository, &["symbolic-ref", "--quiet", "--short", "HEAD"])?,
        "read the worktree branch",
    )?;
    validate_local_branch(repository, &branch, "worktree branch")?;
    Ok(branch)
}

fn validate_local_branch(repository: &Path, branch: &str, label: &str) -> Result<(), String> {
    validate_branch_name(repository, branch, label)?;
    if !local_branch_exists(repository, branch)? {
        return Err(format!("The {label} `{branch}` does not exist locally."));
    }
    Ok(())
}

fn validate_branch_name(repository: &Path, branch: &str, label: &str) -> Result<(), String> {
    if branch.starts_with('-') || branch.contains('\0') {
        return Err(format!("The {label} name is invalid."));
    }
    let output = git(repository, &["check-ref-format", "--branch", branch])?;
    if !output.status.success() {
        return Err(format!(
            "The {label} `{branch}` is not a valid Git branch name."
        ));
    }
    Ok(())
}

fn local_branch_exists(repository: &Path, branch: &str) -> Result<bool, String> {
    let reference = format!("refs/heads/{branch}");
    let output = git(repository, &["show-ref", "--verify", "--quiet", &reference])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(git_failure(output, "check the local branch")),
    }
}

fn parse_worktrees(bytes: Vec<u8>) -> Result<Vec<WorktreeInfo>, String> {
    let mut result = Vec::new();
    let mut current: Option<WorktreeInfo> = None;
    for field in bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let value = std::str::from_utf8(field)
            .map_err(|_| "Git returned a worktree path that is not valid UTF-8.".to_string())?;
        if let Some(path) = value.strip_prefix("worktree ") {
            if let Some(item) = current.take() {
                result.push(item);
            }
            current = Some(WorktreeInfo {
                path: path.to_string(),
                branch: None,
            });
        } else if let Some(branch) = value.strip_prefix("branch refs/heads/") {
            if let Some(item) = current.as_mut() {
                item.branch = Some(branch.to_string());
            }
        }
    }
    if let Some(item) = current {
        result.push(item);
    }
    Ok(result)
}

fn git(repository: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(["-c", "core.hooksPath=/dev/null"])
        .args(args)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))
}

fn git_worktree_add(repository: &Path, args: &[&str]) -> Result<Output, String> {
    let configured = git(
        repository,
        &[
            "config",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|smudge|process|required)$",
        ],
    )?;
    let config_names = match configured.status.code() {
        Some(0) => String::from_utf8(configured.stdout)
            .map_err(|_| "Git returned invalid filter configuration text.".to_string())?,
        Some(1) => String::new(),
        _ => {
            return Err(git_failure(
                configured,
                "inspect configured checkout filters",
            ))
        }
    };
    let drivers = config_names
        .lines()
        .filter_map(|name| {
            name.strip_prefix("filter.")
                .and_then(|rest| rest.rsplit_once('.'))
                .map(|(driver, _)| driver.to_string())
        })
        .collect::<HashSet<_>>();

    let mut command = Command::new("git");
    command.args(["-c", "core.hooksPath=/dev/null"]);
    for driver in drivers {
        for setting in ["clean", "smudge", "process"] {
            command.arg("-c").arg(format!("filter.{driver}.{setting}="));
        }
        command
            .arg("-c")
            .arg(format!("filter.{driver}.required=false"));
    }
    command
        .args(args)
        .current_dir(repository)
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))
}

fn git_text(output: Output, action: &str) -> Result<String, String> {
    let bytes = ensure_success(output, action)?;
    String::from_utf8(bytes)
        .map(|text| text.trim().to_string())
        .map_err(|_| format!("Git returned invalid text while trying to {action}."))
}

fn ensure_success(output: Output, action: &str) -> Result<Vec<u8>, String> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(git_failure(output, action))
    }
}

fn git_failure(output: Output, action: &str) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!("Git could not {action}.")
    } else {
        format!("Git could not {action}: {detail}")
    }
}

fn path_text<'a>(path: &'a Path, label: &str) -> Result<&'a str, String> {
    path.to_str()
        .ok_or_else(|| format!("The {label} path cannot be represented safely."))
}

fn slug(value: &str) -> Result<String, String> {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        Err("The card ID must contain a letter or number.".to_string())
    } else {
        Ok(slug.chars().take(64).collect())
    }
}

fn short_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "patchdeck-{name}-{}",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            run(&root, &["init", "-b", "main"]);
            run(&root, &["config", "user.email", "test@example.com"]);
            run(&root, &["config", "user.name", "Patchdeck Test"]);
            fs::write(root.join("tracked.txt"), "initial\n").unwrap();
            run(&root, &["add", "tracked.txt"]);
            run(&root, &["commit", "-m", "initial"]);
            Self { root }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn run(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn creates_isolated_workspace_without_touching_source_changes_and_retries() {
        let fixture = Fixture::new("create");
        fs::write(fixture.root.join("tracked.txt"), "dirty\n").unwrap();
        let managed = fixture.root.with_extension("worktrees");
        let first = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "CARD 42",
            "main",
            None,
        )
        .unwrap();
        let second = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "CARD 42",
            "main",
            None,
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
            "dirty\n"
        );
        assert_eq!(
            current_branch(Path::new(&first.worktree_path)).unwrap(),
            first.branch
        );
        assert!(list_worktrees(fixture.root.to_str().unwrap())
            .unwrap()
            .iter()
            .any(|item| {
                item.path == first.worktree_path
                    && item.branch.as_deref() == Some(first.branch.as_str())
            }));
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn card_ids_with_the_same_slug_get_distinct_workspaces() {
        let fixture = Fixture::new("card-id-collision");
        let managed = fixture.root.with_extension("worktrees");
        let spaced = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "CARD 42",
            "main",
            None,
        )
        .unwrap();
        let dashed = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "CARD-42",
            "main",
            None,
        )
        .unwrap();

        assert_ne!(spaced.branch, dashed.branch);
        assert_ne!(spaced.worktree_path, dashed.worktree_path);
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn worktree_checkout_does_not_invoke_configured_filters() {
        let fixture = Fixture::new("checkout-filter");
        let managed = fixture.root.with_extension("worktrees");
        let sentinel = fixture.root.with_extension("filter-ran");
        fs::write(
            fixture.root.join(".gitattributes"),
            "*.txt filter=malicious\n",
        )
        .unwrap();
        run(&fixture.root, &["add", ".gitattributes"]);
        run(&fixture.root, &["commit", "-m", "add attributes"]);
        let command = format!("touch {}", sentinel.display());
        run(
            &fixture.root,
            &["config", "filter.malicious.smudge", &command],
        );
        run(
            &fixture.root,
            &["config", "filter.malicious.required", "true"],
        );

        create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "filter-card",
            "main",
            None,
        )
        .unwrap();

        assert!(!sentinel.exists(), "configured smudge filter was invoked");
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn attaches_existing_branch_and_rejects_foreign_repository() {
        let fixture = Fixture::new("attach");
        run(&fixture.root, &["branch", "review"]);
        let managed = fixture.root.with_extension("worktrees");
        let workspace = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "main",
            Some("review"),
        )
        .unwrap();
        assert_eq!(workspace.branch, "review");
        let foreign = Fixture::new("foreign");
        assert!(attach_worktree(
            fixture.root.to_str().unwrap(),
            foreign.root.to_str().unwrap(),
            "main"
        )
        .unwrap_err()
        .contains("different Git repository"));
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn rejects_invalid_names_and_existing_path_mismatch() {
        let fixture = Fixture::new("invalid");
        let managed = fixture.root.with_extension("worktrees");
        assert!(create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "-bad",
            None
        )
        .is_err());
        let workspace = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "main",
            None,
        )
        .unwrap();
        run(&fixture.root, &["branch", "other"]);
        let error = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "main",
            Some("other"),
        )
        .unwrap_err();
        assert!(error.contains("expected `other`"));
        assert!(Path::new(&workspace.worktree_path).exists());
        let _ = fs::remove_dir_all(managed);
    }

    #[test]
    fn refuses_an_unowned_generated_branch_when_the_worktree_is_missing() {
        let fixture = Fixture::new("branch-provenance");
        let managed = fixture.root.with_extension("worktrees");
        let workspace = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "main",
            None,
        )
        .unwrap();
        run(
            &fixture.root,
            &["worktree", "remove", &workspace.worktree_path],
        );

        let error = create_worktree(
            fixture.root.to_str().unwrap(),
            &managed,
            "card",
            "main",
            None,
        )
        .unwrap_err();
        assert!(error.contains("generated branch"));
        assert!(error.contains("existing branch explicitly"));
        let _ = fs::remove_dir_all(managed);
    }
}
