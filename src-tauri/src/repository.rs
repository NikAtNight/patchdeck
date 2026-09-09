use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;

const MAX_RENDERABLE_DIFF_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug)]
pub struct RepositoryError(String);

impl RepositoryError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for RepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<std::io::Error> for RepositoryError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub commit: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
    pub name: String,
    pub path: String,
    pub branches: Vec<Branch>,
    pub current_branch: Option<String>,
    pub suggested_base_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub base_branch: String,
    pub compare_branch: String,
    pub base_commit: String,
    pub compare_commit: String,
    pub merge_base: String,
    pub total_additions: u64,
    pub total_deletions: u64,
    pub files: Vec<ChangedFile>,
    pub revision: String,
    pub mode: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
    pub content: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Addition,
    Deletion,
    Meta,
}

#[derive(Clone, Debug, PartialEq)]
struct NameStatus {
    path: String,
    old_path: Option<String>,
    status: FileStatus,
}

#[derive(Clone, Debug, PartialEq)]
struct NumStat {
    path: String,
    old_path: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
}

struct LimitedGitOutput {
    stdout: Vec<u8>,
    too_large: bool,
}

#[derive(Clone, Debug)]
struct RawChange {
    path: String,
    old_path: Option<String>,
    old_mode: String,
    new_mode: String,
    old_object: String,
    new_object: String,
}

pub fn open(path: &str) -> Result<RepositoryInfo, RepositoryError> {
    let root = resolve_root(path)?;
    let branches = read_branches(&root)?;
    let symbolic_branch = optional_git_text(&root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let current_branch = symbolic_branch
        .map(|branch| branch.trim().to_owned())
        .filter(|name| branches.iter().any(|branch| branch.name == *name));
    let suggested_base_branch = suggested_base(&branches, current_branch.as_deref());
    let name = root
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Repository")
        .to_owned();

    Ok(RepositoryInfo {
        name,
        path: root.to_string_lossy().into_owned(),
        branches,
        current_branch,
        suggested_base_branch,
    })
}

pub fn compare(
    repository_path: &str,
    base_branch: &str,
    compare_branch: &str,
) -> Result<Comparison, RepositoryError> {
    let repository = open(repository_path)?;
    let base_commit = branch_commit(&repository.branches, base_branch)?;
    let compare_commit = branch_commit(&repository.branches, compare_branch)?;
    let root = Path::new(&repository.path);

    let merge_base_output = run_git_allow_status(
        Some(root),
        ["merge-base", base_commit.as_str(), compare_commit.as_str()],
    )?;
    if !merge_base_output.status.success() {
        return Err(RepositoryError::new(format!(
            "{} and {} do not share a common ancestor.",
            base_branch, compare_branch
        )));
    }
    let merge_base = text_output(&merge_base_output)?.trim().to_owned();

    let name_status_output = run_git(
        Some(root),
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--name-status",
            "-z",
            merge_base.as_str(),
            compare_commit.as_str(),
            "--",
        ],
    )?;
    let numstat_output = run_git(
        Some(root),
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--numstat",
            "-z",
            merge_base.as_str(),
            compare_commit.as_str(),
            "--",
        ],
    )?;

    let raw_changes = read_raw_changes(root, &merge_base, Some(&compare_commit))?;

    let statuses = parse_name_status(&name_status_output.stdout)?;
    let stats = parse_numstat(&numstat_output.stdout)?;
    let mut stats_by_path: HashMap<(Option<String>, String), NumStat> = stats
        .into_iter()
        .map(|stat| ((stat.old_path.clone(), stat.path.clone()), stat))
        .collect();

    let mut total_additions = 0;
    let mut total_deletions = 0;
    let mut files = Vec::with_capacity(statuses.len());

    for item in statuses {
        let key = (item.old_path.clone(), item.path.clone());
        let stat = stats_by_path.remove(&key).ok_or_else(|| {
            RepositoryError::new(format!(
                "Git did not return line statistics for '{}'. Refresh and try again.",
                item.path
            ))
        })?;
        let raw = find_raw_change(&raw_changes, &item.path, item.old_path.as_deref())?;
        let gitlink = raw.old_mode == "160000" || raw.new_mode == "160000";
        let additions = if gitlink { None } else { stat.additions };
        let deletions = if gitlink { None } else { stat.deletions };
        let binary = additions.is_none() || deletions.is_none();

        total_additions += additions.unwrap_or(0);
        total_deletions += deletions.unwrap_or(0);
        let fingerprint = change_fingerprint(
            &item,
            &raw.old_mode,
            &raw.new_mode,
            &raw.old_object,
            &raw.new_object,
        );
        files.push(ChangedFile {
            path: item.path,
            old_path: item.old_path,
            status: item.status,
            additions,
            deletions,
            binary,
            fingerprint,
        });
    }

    if !stats_by_path.is_empty() {
        return Err(RepositoryError::new(
            "Git returned line statistics that did not match the changed-file list.",
        ));
    }

    files.sort_by(|left, right| left.path.cmp(&right.path));

    let revision = comparison_revision(&files);
    Ok(Comparison {
        base_branch: base_branch.to_owned(),
        compare_branch: compare_branch.to_owned(),
        base_commit,
        compare_commit,
        merge_base,
        total_additions,
        total_deletions,
        files,
        revision,
        mode: "branch".to_owned(),
    })
}

pub fn compare_working_tree(
    repository_path: &str,
    base_branch: &str,
) -> Result<Comparison, RepositoryError> {
    let repository = open(repository_path)?;
    let base_commit = branch_commit(&repository.branches, base_branch)?;
    let root = Path::new(&repository.path);
    let compare_commit = text_output(&run_git(Some(root), ["rev-parse", "HEAD"])?)?
        .trim()
        .to_owned();
    let merge_output = run_git_allow_status(
        Some(root),
        ["merge-base", base_commit.as_str(), compare_commit.as_str()],
    )?;
    if !merge_output.status.success() {
        return Err(RepositoryError::new(format!(
            "{} and HEAD do not share a common ancestor.",
            base_branch
        )));
    }
    let merge_base = text_output(&merge_output)?.trim().to_owned();
    let name_output = run_git(
        Some(root),
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--name-status",
            "-z",
            merge_base.as_str(),
            "--",
        ],
    )?;
    let stats_output = run_git(
        Some(root),
        [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--numstat",
            "-z",
            merge_base.as_str(),
            "--",
        ],
    )?;
    let raw_changes = read_raw_changes(root, &merge_base, None)?;
    let mut statuses = parse_name_status(&name_output.stdout)?;
    let mut stats = parse_numstat(&stats_output.stdout)?;
    let untracked = run_git(
        Some(root),
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?;
    for field in untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
    {
        let path = decode_git_text(field, "file path")?;
        let (additions, binary) = untracked_stats(root, &path)?;
        if let Some(position) = statuses
            .iter()
            .position(|item| item.path == path && item.status == FileStatus::Deleted)
        {
            let raw = raw_changes
                .iter()
                .find(|raw| raw.path == path && raw.old_path.is_none())
                .ok_or_else(|| RepositoryError::new("Git returned incomplete deletion details."))?;
            let current_mode = working_tree_mode(root, &path)?;
            let net = recreated_file_stats(root, &path, &raw.old_object)?;
            statuses[position].status = if raw.old_mode == current_mode {
                FileStatus::Modified
            } else {
                FileStatus::TypeChanged
            };
            let existing_stat = stats
                .iter_mut()
                .find(|stat| stat.path == path && stat.old_path.is_none())
                .ok_or_else(|| {
                    RepositoryError::new("Git returned incomplete deletion statistics.")
                })?;
            if net.is_none() {
                if raw.old_mode == current_mode {
                    statuses.remove(position);
                    stats.retain(|stat| !(stat.path == path && stat.old_path.is_none()));
                } else {
                    existing_stat.additions = Some(0);
                    existing_stat.deletions = Some(0);
                }
                continue;
            }
            if let Some((net_additions, net_deletions)) = net {
                existing_stat.additions = net_additions;
                existing_stat.deletions = net_deletions;
            }
            continue;
        }
        statuses.push(NameStatus {
            path: path.clone(),
            old_path: None,
            status: FileStatus::Added,
        });
        stats.push(NumStat {
            path,
            old_path: None,
            additions,
            deletions: if binary { None } else { Some(0) },
        });
    }
    let mut stats_by_path: HashMap<(Option<String>, String), NumStat> = stats
        .into_iter()
        .map(|stat| ((stat.old_path.clone(), stat.path.clone()), stat))
        .collect();
    let mut files = Vec::with_capacity(statuses.len());
    let mut total_additions = 0;
    let mut total_deletions = 0;
    for item in statuses {
        let stat = stats_by_path
            .remove(&(item.old_path.clone(), item.path.clone()))
            .ok_or_else(|| {
                RepositoryError::new(format!(
                    "Git did not return line statistics for '{}'. Refresh and try again.",
                    item.path
                ))
            })?;
        let raw = raw_changes
            .iter()
            .find(|raw| raw.path == item.path && raw.old_path == item.old_path);
        let (old_mode, mut new_mode, old_object, new_object) = if let Some(raw) = raw {
            (
                raw.old_mode.as_str(),
                raw.new_mode.as_str(),
                raw.old_object.as_str(),
                raw.new_object.as_str(),
            )
        } else {
            ("000000", working_tree_mode(root, &item.path)?, "0", "0")
        };
        if new_mode == "000000" && item.status != FileStatus::Deleted {
            new_mode = working_tree_mode(root, &item.path)?;
        }
        let current = working_tree_identity(root, &item.path, item.status)?;
        let fingerprint = change_fingerprint(
            &item,
            old_mode,
            new_mode,
            old_object,
            &current.or_else(|| Some(new_object.to_owned())).unwrap(),
        );
        let gitlink = old_mode == "160000" || new_mode == "160000";
        let additions = if gitlink { None } else { stat.additions };
        let deletions = if gitlink { None } else { stat.deletions };
        total_additions += additions.unwrap_or(0);
        total_deletions += deletions.unwrap_or(0);
        files.push(ChangedFile {
            path: item.path,
            old_path: item.old_path,
            status: item.status,
            additions,
            deletions,
            binary: additions.is_none() || deletions.is_none(),
            fingerprint,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let revision = comparison_revision(&files);
    Ok(Comparison {
        base_branch: base_branch.to_owned(),
        compare_branch: repository
            .current_branch
            .unwrap_or_else(|| "HEAD".to_owned()),
        base_commit,
        compare_commit,
        merge_base,
        total_additions,
        total_deletions,
        files,
        revision,
        mode: "workingTree".to_owned(),
    })
}

// Resolves the Git working-tree root without reading branches, so hot paths
// like per-file diff loads cost one Git invocation instead of four.
pub(crate) fn resolve_root(path: &str) -> Result<PathBuf, RepositoryError> {
    let selected_path = Path::new(path);
    if !selected_path.is_dir() {
        return Err(RepositoryError::new(
            "Choose a folder that contains a Git repository.",
        ));
    }
    let root_output = run_git(Some(selected_path), ["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(text_output(&root_output)?.trim()))
}

pub fn commits(
    repository_path: &str,
    merge_base: &str,
    compare_commit: &str,
) -> Result<Vec<CommitInfo>, RepositoryError> {
    validate_commit_id(merge_base)?;
    validate_commit_id(compare_commit)?;
    let root = resolve_root(repository_path)?;
    let range = format!("{merge_base}..{compare_commit}");
    let output = run_git(
        Some(&root),
        [
            "log",
            "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s",
            range.as_str(),
        ],
    )?;

    let mut commits = Vec::new();
    for raw_line in output.stdout.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        let fields: Vec<_> = line.split(|byte| *byte == b'\x1f').collect();
        if fields.len() != 5 {
            return Err(RepositoryError::new("Git returned an invalid commit list."));
        }
        let timestamp = std::str::from_utf8(fields[3])
            .map_err(|_| RepositoryError::new("Git returned an invalid commit timestamp."))?
            .parse::<i64>()
            .map_err(|_| RepositoryError::new("Git returned an invalid commit timestamp."))?;
        commits.push(CommitInfo {
            id: decode_git_text(fields[0], "commit ID")?,
            short_id: decode_git_text(fields[1], "short commit ID")?,
            author: decode_git_text(fields[2], "commit author")?,
            timestamp,
            subject: decode_git_text(fields[4], "commit subject")?,
        });
    }
    Ok(commits)
}

pub fn file_diff(
    repository_path: &str,
    merge_base: &str,
    compare_commit: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileDiff, RepositoryError> {
    validate_commit_id(merge_base)?;
    validate_commit_id(compare_commit)?;
    file_diff_against(
        repository_path,
        merge_base,
        Some(compare_commit),
        path,
        old_path,
    )
}

// Includes staged and unstaged edits in the checked-out working tree. Keep
// ordinary review reads on `file_diff`, which remains commit-to-commit.
pub fn working_tree_file_diff(
    repository_path: &str,
    merge_base: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileDiff, RepositoryError> {
    validate_commit_id(merge_base)?;
    let root = resolve_root(repository_path)?;
    validate_relative_path(&root, path)?;
    if root
        .join(path)
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.is_dir())
    {
        return Ok(FileDiff {
            path: path.to_owned(),
            old_path: old_path.map(str::to_owned),
            binary: true,
            too_large: false,
            hunks: Vec::new(),
        });
    }
    let tracked = run_git_allow_status(Some(&root), ["ls-files", "--error-unmatch", "--", path])?;
    if !tracked.status.success() && root.join(path).symlink_metadata().is_ok() {
        if let Some((_, object)) = tree_entry(&root, merge_base, path)? {
            return recreated_file_diff(&root, path, &object);
        }
        let args: Vec<OsString> = [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            "/dev/null",
            path,
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        let output = run_git_limited_os_allow_one(Some(&root), &args, MAX_RENDERABLE_DIFF_BYTES)?;
        if output.too_large {
            return Ok(FileDiff {
                path: path.to_owned(),
                old_path: None,
                binary: false,
                too_large: true,
                hunks: Vec::new(),
            });
        }
        let patch = String::from_utf8_lossy(&output.stdout);
        let binary = patch
            .lines()
            .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));
        return Ok(FileDiff {
            path: path.to_owned(),
            old_path: None,
            binary,
            too_large: false,
            hunks: if binary {
                Vec::new()
            } else {
                parse_hunks(&patch)
            },
        });
    }
    file_diff_against(repository_path, merge_base, None, path, old_path)
}

fn validate_relative_path(root: &Path, path: &str) -> Result<(), RepositoryError> {
    let relative = Path::new(path);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(RepositoryError::new(
            "The selected file path is outside the repository.",
        ));
    }
    let parent = root
        .join(relative)
        .parent()
        .unwrap_or(root)
        .canonicalize()?;
    let canonical_root = root.canonicalize()?;
    if !parent.starts_with(&canonical_root) {
        return Err(RepositoryError::new(
            "The selected file path is outside the repository.",
        ));
    }
    Ok(())
}

fn untracked_stats(root: &Path, path: &str) -> Result<(Option<u64>, bool), RepositoryError> {
    validate_relative_path(root, path)?;
    let target = root.join(path);
    let metadata = target.symlink_metadata()?;
    if metadata.is_dir() {
        return Ok((None, true));
    }
    let bytes = if metadata.file_type().is_symlink() {
        target.read_link()?.as_os_str().as_encoded_bytes().to_vec()
    } else {
        let file = std::fs::File::open(&target)?;
        let mut bytes = Vec::new();
        file.take(MAX_RENDERABLE_DIFF_BYTES.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        bytes
    };
    let binary = bytes.iter().take(8_000).any(|byte| *byte == 0);
    let additions = if binary {
        None
    } else {
        Some(
            bytes.iter().filter(|byte| **byte == b'\n').count() as u64
                + u64::from(!bytes.is_empty() && !bytes.ends_with(b"\n")),
        )
    };
    Ok((additions, binary))
}

fn recreated_file_stats(
    root: &Path,
    path: &str,
    old_object: &str,
) -> Result<Option<(Option<u64>, Option<u64>)>, RepositoryError> {
    let old = read_blob_limited(root, old_object)?;
    let current = read_worktree_file_limited(root, path)?;
    if !old.too_large && !current.too_large && old.stdout == current.stdout {
        return Ok(None);
    }
    if old.too_large || current.too_large {
        return Ok(Some((None, None)));
    }
    let temporary = TemporaryBlob::new(&old.stdout)?;
    let current_temporary = TemporaryBlob::new(&current.stdout)?;
    let output = run_git_allow_status(
        Some(root),
        [
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--numstat",
            "-z",
            "--",
            temporary
                .path
                .to_str()
                .ok_or_else(|| RepositoryError::new("Temporary path is not valid UTF-8."))?,
            current_temporary
                .path
                .to_str()
                .ok_or_else(|| RepositoryError::new("Temporary path is not valid UTF-8."))?,
        ],
    )?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(command_error(&output));
    }
    let stat = parse_numstat(&output.stdout)?
        .into_iter()
        .next()
        .ok_or_else(|| {
            RepositoryError::new("Git returned incomplete recreated-file statistics.")
        })?;
    Ok(Some((stat.additions, stat.deletions)))
}

fn recreated_file_diff(
    root: &Path,
    path: &str,
    old_object: &str,
) -> Result<FileDiff, RepositoryError> {
    let old = read_blob_limited(root, old_object)?;
    let current = read_worktree_file_limited(root, path)?;
    if old.too_large || current.too_large {
        return Ok(FileDiff {
            path: path.to_owned(),
            old_path: None,
            binary: false,
            too_large: true,
            hunks: Vec::new(),
        });
    }
    let temporary = TemporaryBlob::new(&old.stdout)?;
    let current_temporary = TemporaryBlob::new(&current.stdout)?;
    let args: Vec<OsString> = [
        OsString::from("diff"),
        OsString::from("--no-index"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
        OsString::from("--unified=3"),
        OsString::from("--"),
        temporary.path.as_os_str().to_owned(),
        current_temporary.path.as_os_str().to_owned(),
    ]
    .into_iter()
    .collect();
    let output = run_git_limited_os_allow_one(Some(root), &args, MAX_RENDERABLE_DIFF_BYTES)?;
    if output.too_large {
        return Ok(FileDiff {
            path: path.to_owned(),
            old_path: None,
            binary: false,
            too_large: true,
            hunks: Vec::new(),
        });
    }
    let patch = String::from_utf8_lossy(&output.stdout);
    let binary = patch
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));
    Ok(FileDiff {
        path: path.to_owned(),
        old_path: None,
        binary,
        too_large: false,
        hunks: if binary {
            Vec::new()
        } else {
            parse_hunks(&patch)
        },
    })
}

fn read_blob_limited(root: &Path, object: &str) -> Result<LimitedGitOutput, RepositoryError> {
    let args = [
        OsString::from("cat-file"),
        OsString::from("blob"),
        OsString::from(object),
    ];
    run_git_limited_os(Some(root), &args, MAX_RENDERABLE_DIFF_BYTES)
}

fn read_worktree_file_limited(
    root: &Path,
    path: &str,
) -> Result<LimitedGitOutput, RepositoryError> {
    validate_relative_path(root, path)?;
    let target = root.join(path);
    let metadata = target.symlink_metadata()?;
    if metadata.file_type().is_symlink() {
        return Ok(LimitedGitOutput {
            stdout: target.read_link()?.as_os_str().as_encoded_bytes().to_vec(),
            too_large: false,
        });
    }
    let file = std::fs::File::open(target)?;
    let mut stdout = Vec::with_capacity(MAX_RENDERABLE_DIFF_BYTES + 1);
    file.take((MAX_RENDERABLE_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut stdout)?;
    let too_large = stdout.len() > MAX_RENDERABLE_DIFF_BYTES;
    if too_large {
        stdout.clear();
    }
    Ok(LimitedGitOutput { stdout, too_large })
}

fn tree_entry(
    root: &Path,
    commit: &str,
    path: &str,
) -> Result<Option<(String, String)>, RepositoryError> {
    let output = run_git(Some(root), ["ls-tree", "-z", commit, "--", path])?;
    if output.stdout.is_empty() {
        return Ok(None);
    }
    let record = output
        .stdout
        .split(|byte| *byte == 0)
        .next()
        .unwrap_or_default();
    let header = record
        .split(|byte| *byte == b'\t')
        .next()
        .unwrap_or_default();
    let fields: Vec<_> = header.split(|byte| *byte == b' ').collect();
    if fields.len() != 3 {
        return Err(RepositoryError::new("Git returned an invalid tree entry."));
    }
    Ok(Some((
        decode_git_text(fields[0], "file mode")?,
        decode_git_text(fields[2], "object ID")?,
    )))
}

struct TemporaryBlob {
    path: PathBuf,
}

impl TemporaryBlob {
    fn new(bytes: &[u8]) -> Result<Self, RepositoryError> {
        use std::io::Write;
        for attempt in 0..100_u32 {
            let path = std::env::temp_dir().join(format!(
                "patchdeck-diff-{}-{}-{attempt}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(mut file) => {
                    let temporary = Self { path };
                    file.write_all(bytes)?;
                    return Ok(temporary);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(RepositoryError::new(
            "Could not create a temporary comparison file.",
        ))
    }
}

impl Drop for TemporaryBlob {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn working_tree_mode(root: &Path, path: &str) -> Result<&'static str, RepositoryError> {
    validate_relative_path(root, path)?;
    let metadata = root.join(path).symlink_metadata()?;
    if metadata.file_type().is_symlink() {
        return Ok("120000");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Ok("100755");
        }
    }
    Ok("100644")
}

fn working_tree_identity(
    root: &Path,
    path: &str,
    status: FileStatus,
) -> Result<Option<String>, RepositoryError> {
    if status == FileStatus::Deleted {
        return Ok(Some("deleted".to_owned()));
    }
    validate_relative_path(root, path)?;
    let target = root.join(path);
    let metadata = target.symlink_metadata()?;
    let mut hasher = Sha256::new();
    if metadata.file_type().is_symlink() {
        hasher.update(target.read_link()?.as_os_str().as_encoded_bytes());
    } else if metadata.is_dir() {
        hasher.update(b"directory\0");
        let head = optional_git_text(&target, ["rev-parse", "--verify", "HEAD"])?;
        hasher.update(head.unwrap_or_default().trim().as_bytes());
    } else if metadata.len() > MAX_RENDERABLE_DIFF_BYTES as u64 {
        hasher.update(b"oversized\0");
        hasher.update(metadata.len().to_be_bytes());
        if let Ok(modified) = metadata.modified() {
            if let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) {
                hasher.update(since_epoch.as_secs().to_be_bytes());
                hasher.update(since_epoch.subsec_nanos().to_be_bytes());
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            hasher.update(metadata.dev().to_be_bytes());
            hasher.update(metadata.ino().to_be_bytes());
            hasher.update(metadata.ctime().to_be_bytes());
            hasher.update(metadata.ctime_nsec().to_be_bytes());
        }
    } else {
        let mut file = std::fs::File::open(target)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
    }
    Ok(Some(format!("sha256:{:x}", hasher.finalize())))
}

fn read_raw_changes(
    root: &Path,
    base: &str,
    compare: Option<&str>,
) -> Result<Vec<RawChange>, RepositoryError> {
    let mut args = vec![
        OsString::from("diff"),
        OsString::from("--no-ext-diff"),
        OsString::from("--no-textconv"),
        OsString::from("--no-color"),
        OsString::from("--find-renames"),
        OsString::from("--raw"),
        OsString::from("--full-index"),
        OsString::from("-z"),
        OsString::from(base),
    ];
    if let Some(compare) = compare {
        args.push(OsString::from(compare));
    }
    args.push(OsString::from("--"));
    let output = run_git(Some(root), args)?;
    parse_raw_changes(&output.stdout)
}

fn parse_raw_changes(bytes: &[u8]) -> Result<Vec<RawChange>, RepositoryError> {
    let fields: Vec<_> = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut index = 0;
    let mut changes = Vec::new();
    while index < fields.len() {
        let header = decode_git_text(fields[index], "raw change")?;
        index += 1;
        let parts: Vec<_> = header.split_whitespace().collect();
        if parts.len() != 5 || !parts[0].starts_with(':') || index >= fields.len() {
            return Err(RepositoryError::new(
                "Git returned an invalid raw change list.",
            ));
        }
        let renamed = parts[4].starts_with('R') || parts[4].starts_with('C');
        let first_path = decode_git_text(fields[index], "file path")?;
        index += 1;
        let (old_path, path) = if renamed {
            if index >= fields.len() {
                return Err(RepositoryError::new(
                    "Git returned an incomplete raw rename.",
                ));
            }
            let path = decode_git_text(fields[index], "file path")?;
            index += 1;
            (Some(first_path), path)
        } else {
            (None, first_path)
        };
        changes.push(RawChange {
            path,
            old_path,
            old_mode: parts[0][1..].to_owned(),
            new_mode: parts[1].to_owned(),
            old_object: parts[2].to_owned(),
            new_object: parts[3].to_owned(),
        });
    }
    Ok(changes)
}

fn find_raw_change<'a>(
    changes: &'a [RawChange],
    path: &str,
    old_path: Option<&str>,
) -> Result<&'a RawChange, RepositoryError> {
    changes
        .iter()
        .find(|change| change.path == path && change.old_path.as_deref() == old_path)
        .ok_or_else(|| {
            RepositoryError::new(format!(
                "Git did not return object information for '{path}'. Refresh and try again."
            ))
        })
}

fn change_fingerprint(
    item: &NameStatus,
    old_mode: &str,
    new_mode: &str,
    old_object: &str,
    new_object: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        format!("{:?}", item.status),
        item.old_path.clone().unwrap_or_default(),
        item.path.clone(),
        old_mode.to_owned(),
        new_mode.to_owned(),
        old_object.to_owned(),
        new_object.to_owned(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn comparison_revision(files: &[ChangedFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.fingerprint.as_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn file_diff_against(
    repository_path: &str,
    merge_base: &str,
    compare_commit: Option<&str>,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileDiff, RepositoryError> {
    let root = resolve_root(repository_path)?;
    let root = root.as_path();

    let mut args: Vec<OsString> = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--unified=3",
        merge_base,
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    if let Some(compare_commit) = compare_commit {
        args.push(OsString::from(compare_commit));
    }
    args.push(OsString::from("--"));
    if let Some(previous_path) = old_path {
        args.push(OsString::from(previous_path));
    }
    args.push(OsString::from(path));

    let output = run_git_limited_os(Some(root), &args, MAX_RENDERABLE_DIFF_BYTES)?;
    if output.too_large {
        return Ok(FileDiff {
            path: path.to_owned(),
            old_path: old_path.map(str::to_owned),
            binary: false,
            too_large: true,
            hunks: Vec::new(),
        });
    }

    let patch = String::from_utf8_lossy(&output.stdout);
    let binary = patch
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));

    Ok(FileDiff {
        path: path.to_owned(),
        old_path: old_path.map(str::to_owned),
        binary,
        too_large: false,
        hunks: if binary {
            Vec::new()
        } else {
            parse_hunks(&patch)
        },
    })
}

fn read_branches(root: &Path) -> Result<Vec<Branch>, RepositoryError> {
    let output = run_git(
        Some(root),
        [
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)",
            "refs/heads/",
        ],
    )?;
    let mut branches = Vec::new();
    for raw_line in output.stdout.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if line.is_empty() {
            continue;
        }
        let Some(separator) = line.iter().position(|byte| *byte == 0) else {
            return Err(RepositoryError::new("Git returned an invalid branch list."));
        };
        branches.push(Branch {
            name: decode_git_text(&line[..separator], "branch name")?,
            commit: decode_git_text(&line[separator + 1..], "branch commit")?,
        });
    }
    branches.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(branches)
}

fn suggested_base(branches: &[Branch], current: Option<&str>) -> Option<String> {
    ["main", "master"]
        .into_iter()
        .find(|name| Some(*name) != current && branches.iter().any(|branch| branch.name == *name))
        .or_else(|| {
            branches
                .iter()
                .find(|branch| Some(branch.name.as_str()) != current)
                .map(|branch| branch.name.as_str())
        })
        .map(str::to_owned)
}

fn branch_commit(branches: &[Branch], name: &str) -> Result<String, RepositoryError> {
    branches
        .iter()
        .find(|branch| branch.name == name)
        .map(|branch| branch.commit.clone())
        .ok_or_else(|| RepositoryError::new(format!("Local branch '{name}' no longer exists.")))
}

fn validate_commit_id(value: &str) -> Result<(), RepositoryError> {
    if (40..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(RepositoryError::new(
            "The comparison snapshot is invalid. Refresh and try again.",
        ))
    }
}

fn parse_name_status(bytes: &[u8]) -> Result<Vec<NameStatus>, RepositoryError> {
    let fields: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut index = 0;
    let mut result = Vec::new();

    while index < fields.len() {
        let code = decode_git_text(fields[index], "file status")?;
        index += 1;
        let status = match code.as_bytes().first().copied() {
            Some(b'A') => FileStatus::Added,
            Some(b'M') => FileStatus::Modified,
            Some(b'D') => FileStatus::Deleted,
            Some(b'R') => FileStatus::Renamed,
            Some(b'T') => FileStatus::TypeChanged,
            Some(b'U') => FileStatus::Unmerged,
            _ => FileStatus::Unknown,
        };
        let renamed = matches!(status, FileStatus::Renamed) || code.starts_with('C');
        if renamed {
            if index + 1 >= fields.len() {
                return Err(RepositoryError::new(
                    "Git returned an incomplete renamed-file record.",
                ));
            }
            let old_path = decode_git_text(fields[index], "file path")?;
            let path = decode_git_text(fields[index + 1], "file path")?;
            index += 2;
            result.push(NameStatus {
                path,
                old_path: Some(old_path),
                status: FileStatus::Renamed,
            });
        } else {
            if index >= fields.len() {
                return Err(RepositoryError::new(
                    "Git returned an incomplete file-status record.",
                ));
            }
            result.push(NameStatus {
                path: decode_git_text(fields[index], "file path")?,
                old_path: None,
                status,
            });
            index += 1;
        }
    }

    Ok(result)
}

fn parse_numstat(bytes: &[u8]) -> Result<Vec<NumStat>, RepositoryError> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut index = 0;
    let mut result = Vec::new();

    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, |byte| *byte == b'\t');
        let additions = parts
            .next()
            .ok_or_else(|| RepositoryError::new("Invalid Git numstat output."))?;
        let deletions = parts
            .next()
            .ok_or_else(|| RepositoryError::new("Invalid Git numstat output."))?;
        let inline_path = parts
            .next()
            .ok_or_else(|| RepositoryError::new("Invalid Git numstat output."))?;

        let (old_path, path) = if inline_path.is_empty() {
            if index + 1 >= fields.len() {
                return Err(RepositoryError::new(
                    "Git returned an incomplete rename numstat record.",
                ));
            }
            let old = decode_git_text(fields[index], "file path")?;
            let new = decode_git_text(fields[index + 1], "file path")?;
            index += 2;
            (Some(old), new)
        } else {
            (None, decode_git_text(inline_path, "file path")?)
        };

        result.push(NumStat {
            path,
            old_path,
            additions: parse_line_count(additions)?,
            deletions: parse_line_count(deletions)?,
        });
    }

    Ok(result)
}

fn parse_line_count(bytes: &[u8]) -> Result<Option<u64>, RepositoryError> {
    if bytes == b"-" {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(bytes)
        .parse::<u64>()
        .map_err(|_| RepositoryError::new("Git returned an invalid line count."))?;
    Ok(Some(value))
}

fn decode_git_text(bytes: &[u8], field: &str) -> Result<String, RepositoryError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        RepositoryError::new(format!(
            "Git returned a {field} that is not valid UTF-8 and cannot be displayed safely."
        ))
    })
}

fn parse_hunks(patch: &str) -> Vec<DiffHunk> {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut old_line = 0;
    let mut new_line = 0;

    for line in patch.lines() {
        if line.starts_with("@@ ") {
            let Some((old_start, new_start)) = parse_hunk_header(line) else {
                continue;
            };
            old_line = old_start;
            new_line = new_start;
            hunks.push(DiffHunk {
                header: line.to_owned(),
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = hunks.last_mut() else {
            continue;
        };
        if line.starts_with("diff --git ") {
            continue;
        }

        let (kind, previous, next, content) = match line.as_bytes().first().copied() {
            Some(b'+') => {
                let current = new_line;
                new_line += 1;
                (DiffLineKind::Addition, None, Some(current), &line[1..])
            }
            Some(b'-') => {
                let current = old_line;
                old_line += 1;
                (DiffLineKind::Deletion, Some(current), None, &line[1..])
            }
            Some(b' ') => {
                let previous = old_line;
                let next = new_line;
                old_line += 1;
                new_line += 1;
                (
                    DiffLineKind::Context,
                    Some(previous),
                    Some(next),
                    &line[1..],
                )
            }
            Some(b'\\') => (DiffLineKind::Meta, None, None, line),
            _ => continue,
        };
        hunk.lines.push(DiffLine {
            kind,
            old_line: previous,
            new_line: next,
            content: content.to_owned(),
        });
    }

    hunks
}

fn parse_hunk_header(header: &str) -> Option<(u64, u64)> {
    let mut parts = header.split_whitespace();
    if parts.next()? != "@@" {
        return None;
    }
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    Some((range_start(old)?, range_start(new)?))
}

fn range_start(range: &str) -> Option<u64> {
    range.split(',').next()?.parse().ok()
}

fn run_git<I, S>(directory: Option<&Path>, args: I) -> Result<Output, RepositoryError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_allow_status(directory, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(&output))
    }
}

fn run_git_allow_status<I, S>(directory: Option<&Path>, args: I) -> Result<Output, RepositoryError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(directory);
    command.args(args);
    command.output().map_err(git_spawn_error)
}

fn run_git_limited_os(
    directory: Option<&Path>,
    args: &[OsString],
    limit: usize,
) -> Result<LimitedGitOutput, RepositoryError> {
    let mut command = git_command(directory);
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(git_spawn_error)?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RepositoryError::new("Could not read Git error output."))?;
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stderr;
        let result = reader.read_to_end(&mut bytes);
        (result, bytes)
    });
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RepositoryError::new("Could not read Git diff output."))?;
    let mut bytes = Vec::with_capacity(limit.saturating_add(1));
    let read_result = stdout
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes);
    let too_large = bytes.len() > limit;
    if too_large || read_result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let (stderr_result, stderr) = stderr_reader
        .join()
        .map_err(|_| RepositoryError::new("Could not finish reading Git error output."))?;
    read_result.map_err(RepositoryError::from)?;
    stderr_result.map_err(RepositoryError::from)?;

    if too_large {
        return Ok(LimitedGitOutput {
            stdout: Vec::new(),
            too_large: true,
        });
    }
    if !status.success() {
        return Err(command_error_text(&stderr));
    }
    Ok(LimitedGitOutput {
        stdout: bytes,
        too_large: false,
    })
}

fn run_git_limited_os_allow_one(
    directory: Option<&Path>,
    args: &[OsString],
    limit: usize,
) -> Result<LimitedGitOutput, RepositoryError> {
    let mut command = git_command(directory);
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(git_spawn_error)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RepositoryError::new("Could not read Git diff output."))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| RepositoryError::new("Could not read Git error output."))?;
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr.read_to_end(&mut bytes);
        (result, bytes)
    });
    let mut bytes = Vec::with_capacity(limit.saturating_add(1));
    let read_result = stdout
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes);
    let too_large = bytes.len() > limit;
    if too_large || read_result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait()?;
    let (stderr_result, stderr) = stderr_reader
        .join()
        .map_err(|_| RepositoryError::new("Could not finish reading Git error output."))?;
    read_result?;
    stderr_result?;
    if too_large {
        return Ok(LimitedGitOutput {
            stdout: Vec::new(),
            too_large: true,
        });
    }
    if !status.success() && status.code() != Some(1) {
        return Err(command_error_text(&stderr));
    }
    Ok(LimitedGitOutput {
        stdout: bytes,
        too_large: false,
    })
}

fn git_command(directory: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--literal-pathspecs")
        .arg("--no-pager")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    if let Some(path) = directory {
        command.arg("-C").arg(path);
    }
    command
}

fn git_spawn_error(error: std::io::Error) -> RepositoryError {
    if error.kind() == std::io::ErrorKind::NotFound {
        RepositoryError::new("Git is not installed or is not available on PATH.")
    } else {
        RepositoryError::new(format!("Could not run Git: {error}"))
    }
}

fn optional_git_text<I, S>(directory: &Path, args: I) -> Result<Option<String>, RepositoryError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_allow_status(Some(directory), args)?;
    if output.status.success() {
        Ok(Some(text_output(&output)?))
    } else if output.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(command_error(&output))
    }
}

fn text_output(output: &Output) -> Result<String, RepositoryError> {
    String::from_utf8(output.stdout.clone())
        .map_err(|_| RepositoryError::new("Git returned text that could not be decoded as UTF-8."))
}

fn command_error(output: &Output) -> RepositoryError {
    command_error_text(&output.stderr)
}

fn command_error_text(stderr: &[u8]) -> RepositoryError {
    let stderr = String::from_utf8_lossy(stderr);
    let message = stderr.trim();
    if message.is_empty() {
        RepositoryError::new("Git could not complete the requested read operation.")
    } else {
        RepositoryError::new(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn parses_name_status_including_renames() {
        let parsed =
            parse_name_status(b"M\0src/main.rs\0R100\0old name.md\0new name.md\0").unwrap();
        assert_eq!(
            parsed,
            vec![
                NameStatus {
                    path: "src/main.rs".into(),
                    old_path: None,
                    status: FileStatus::Modified,
                },
                NameStatus {
                    path: "new name.md".into(),
                    old_path: Some("old name.md".into()),
                    status: FileStatus::Renamed,
                },
            ]
        );
    }

    #[test]
    fn parses_numstat_for_text_binary_and_renamed_files() {
        let parsed =
            parse_numstat(b"4\t2\tsrc/main.rs\0-\t-\timage.png\0\x33\t1\t\0old.md\0new.md\0")
                .unwrap();
        assert_eq!(parsed[0].additions, Some(4));
        assert_eq!(parsed[1].additions, None);
        assert_eq!(parsed[2].old_path.as_deref(), Some("old.md"));
        assert_eq!(parsed[2].path, "new.md");
    }

    #[test]
    fn parses_unified_diff_line_numbers() {
        let patch = "diff --git a/file b/file\n@@ -2,2 +2,3 @@ title\n same\n-old\n+new\n+extra\n";
        let hunks = parse_hunks(patch);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines[0].old_line, Some(2));
        assert_eq!(hunks[0].lines[0].new_line, Some(2));
        assert_eq!(hunks[0].lines[1].old_line, Some(3));
        assert_eq!(hunks[0].lines[1].new_line, None);
        assert_eq!(hunks[0].lines[2].old_line, None);
        assert_eq!(hunks[0].lines[2].new_line, Some(3));
        assert_eq!(hunks[0].lines[3].new_line, Some(4));
    }

    #[test]
    fn compares_a_real_repository_without_changing_it() {
        let fixture = FixtureRepository::new();
        fixture.write("tracked.txt", "first\nsecond\n");
        fixture.git(["add", "tracked.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write("tracked.txt", "first\nchanged\nthird\n");
        fixture.write("added file.txt", "hello\n");
        fixture.git(["add", "tracked.txt", "added file.txt"]);
        fixture.git(["commit", "-m", "feature changes"]);

        let before = fixture.snapshot();
        let repository = open(fixture.path.to_str().unwrap()).unwrap();
        let comparison = compare(&repository.path, "main", "feature").unwrap();
        assert_eq!(repository.current_branch.as_deref(), Some("feature"));
        assert_eq!(repository.suggested_base_branch.as_deref(), Some("main"));
        assert_eq!(comparison.files.len(), 2);
        assert_eq!(comparison.total_additions, 3);
        assert_eq!(comparison.total_deletions, 1);
        assert_eq!(comparison.mode, "branch");
        assert!(comparison.revision.starts_with("sha256:"));
        assert!(comparison
            .files
            .iter()
            .all(|file| file.fingerprint.starts_with("sha256:")));

        let changed = comparison
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap();
        let diff = file_diff(
            &repository.path,
            &comparison.merge_base,
            &comparison.compare_commit,
            &changed.path,
            changed.old_path.as_deref(),
        )
        .unwrap();
        assert!(!diff.hunks.is_empty());
        let after = fixture.snapshot();
        assert_eq!(before, after, "read operations changed repository state");
    }

    #[test]
    fn working_tree_diff_includes_an_edit_made_after_the_branch_commit() {
        let fixture = FixtureRepository::new();
        fixture.write("tracked.txt", "base\n");
        fixture.git(["add", "tracked.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write("tracked.txt", "committed branch edit\n");
        fixture.git(["add", "tracked.txt"]);
        fixture.git(["commit", "-m", "feature edit"]);

        let merge_base = fixture.git(["rev-parse", "main"]);
        let compare_commit = fixture.git(["rev-parse", "feature"]);
        fixture.write("tracked.txt", "uncommitted editor edit\n");

        let committed = file_diff(
            fixture.path.to_str().unwrap(),
            &merge_base,
            &compare_commit,
            "tracked.txt",
            None,
        )
        .unwrap();
        let working = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &merge_base,
            "tracked.txt",
            None,
        )
        .unwrap();

        assert!(diff_contents(&committed).contains("committed branch edit"));
        assert!(!diff_contents(&committed).contains("uncommitted editor edit"));
        assert!(diff_contents(&working).contains("uncommitted editor edit"));
    }

    #[test]
    fn compares_staged_unstaged_and_untracked_work_without_index_writes() {
        let fixture = FixtureRepository::new();
        fixture.write("staged.txt", "base\n");
        fixture.write("deleted.txt", "delete me\n");
        fixture.write(".gitignore", "ignored.txt\n");
        fixture.git(["add", "."]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write("staged.txt", "staged\n");
        fixture.git(["add", "staged.txt"]);
        fixture.write("staged.txt", "staged and unstaged\n");
        fs::remove_file(fixture.path.join("deleted.txt")).unwrap();
        fixture.write("new file.txt", "new\ncontent\n");
        fixture.write("ignored.txt", "hidden\n");
        fixture.write_bytes("new.bin", &[0, 1, 2, 3]);

        let before = fixture.snapshot();
        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_eq!(comparison.mode, "workingTree");
        assert_eq!(
            comparison.compare_commit,
            fixture.git(["rev-parse", "HEAD"])
        );
        assert_eq!(comparison.files.len(), 4);
        assert!(comparison
            .files
            .iter()
            .any(|file| file.path == "staged.txt" && file.status == FileStatus::Modified));
        assert!(comparison
            .files
            .iter()
            .any(|file| file.path == "deleted.txt" && file.status == FileStatus::Deleted));
        assert!(comparison
            .files
            .iter()
            .any(|file| file.path == "new file.txt"
                && file.status == FileStatus::Added
                && file.additions == Some(2)));
        assert!(comparison
            .files
            .iter()
            .any(|file| file.path == "new.bin" && file.binary));
        assert!(!comparison
            .files
            .iter()
            .any(|file| file.path == "ignored.txt"));
        let diff = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            "new file.txt",
            None,
        )
        .unwrap();
        assert!(diff_contents(&diff).contains("content"));
        assert_eq!(
            before,
            fixture.snapshot(),
            "comparison changed repository state"
        );
    }

    #[test]
    fn fingerprints_are_stable_until_that_file_changes() {
        let fixture = FixtureRepository::new();
        fixture.write("tracked.txt", "base\n");
        fixture.git(["add", "tracked.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write("tracked.txt", "changed\n");
        let first = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let fingerprint = first
            .files
            .iter()
            .find(|file| file.path == "tracked.txt")
            .unwrap()
            .fingerprint
            .clone();

        fixture.write("unrelated.txt", "one\n");
        let unrelated = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_eq!(
            fingerprint,
            unrelated
                .files
                .iter()
                .find(|file| file.path == "tracked.txt")
                .unwrap()
                .fingerprint
        );
        assert_ne!(first.revision, unrelated.revision);

        fixture.write("tracked.txt", "changed again\n");
        let changed = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_ne!(
            fingerprint,
            changed
                .files
                .iter()
                .find(|file| file.path == "tracked.txt")
                .unwrap()
                .fingerprint
        );
    }

    #[test]
    fn rejects_working_tree_paths_that_escape_the_repository() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        let head = fixture.git(["rev-parse", "HEAD"]);
        let error = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &head,
            "../outside.txt",
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("outside the repository"));
    }

    #[test]
    fn working_tree_comparison_handles_renames_and_option_like_paths() {
        let fixture = FixtureRepository::new();
        fixture.write("old.txt", "one\ntwo\nthree\n");
        fixture.git(["add", "old.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.git(["mv", "old.txt", "new.txt"]);
        fixture.write("-untracked.txt", "literal\n");

        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let renamed = comparison
            .files
            .iter()
            .find(|file| file.path == "new.txt")
            .unwrap();
        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        let untracked = comparison
            .files
            .iter()
            .find(|file| file.path == "-untracked.txt")
            .unwrap();
        let diff = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            &untracked.path,
            None,
        )
        .unwrap();
        assert!(diff_contents(&diff).contains("literal"));
    }

    #[cfg(unix)]
    #[test]
    fn hashes_untracked_symlinks_without_following_them() {
        use std::os::unix::fs::symlink;

        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        symlink("../../outside-secret", fixture.path.join("link")).unwrap();

        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let link = comparison
            .files
            .iter()
            .find(|file| file.path == "link")
            .unwrap();
        assert_eq!(link.status, FileStatus::Added);
        assert!(!link.fingerprint.is_empty());
    }

    #[test]
    fn coalesces_an_index_deletion_and_same_path_untracked_file() {
        let fixture = FixtureRepository::new();
        fixture.write("recreated.txt", "keep\nold\ntail\n");
        fixture.git(["add", "recreated.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["rm", "--cached", "recreated.txt"]);
        fixture.write("recreated.txt", "keep\nnew\ntail\n");

        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let file = comparison
            .files
            .iter()
            .find(|file| file.path == "recreated.txt")
            .unwrap();
        assert_eq!(comparison.files.len(), 1);
        assert_eq!(file.status, FileStatus::Modified);
        assert_eq!(file.additions, Some(1));
        assert_eq!(file.deletions, Some(1));
        let diff = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            "recreated.txt",
            None,
        )
        .unwrap();
        let contents = diff_contents(&diff);
        assert!(contents.contains("old"));
        assert!(contents.contains("new"));
    }

    #[test]
    fn omits_an_identical_file_recreated_after_index_deletion() {
        let fixture = FixtureRepository::new();
        fixture.write("recreated.txt", "base\n");
        fixture.git(["add", "recreated.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["rm", "--cached", "recreated.txt"]);
        fixture.write("recreated.txt", "base\n");

        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert!(comparison.files.is_empty());
    }

    #[test]
    fn committed_deletion_with_untracked_recreation_is_a_net_modification() {
        let fixture = FixtureRepository::new();
        fixture.write("recreated.txt", "keep\nold\ntail\n");
        fixture.git(["add", "recreated.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.git(["rm", "recreated.txt"]);
        fixture.git(["commit", "-m", "delete"]);
        fixture.write("recreated.txt", "keep\nnew\ntail\n");

        let comparison = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_eq!(comparison.files.len(), 1);
        assert_eq!(comparison.files[0].status, FileStatus::Modified);
        assert_eq!(comparison.files[0].additions, Some(1));
        assert_eq!(comparison.files[0].deletions, Some(1));
    }

    #[cfg(unix)]
    #[test]
    fn recreated_symlinks_use_link_bytes_without_reading_their_targets() {
        use std::os::unix::fs::symlink;

        let fixture = FixtureRepository::new();
        fixture.write("recreated", "base contents\n");
        fixture.git(["add", "recreated"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["rm", "--cached", "recreated"]);
        fs::remove_file(fixture.path.join("recreated")).unwrap();

        let outside = fixture.path.with_extension("outside-directory");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "must not appear in diff\n").unwrap();
        symlink(&outside, fixture.path.join("recreated")).unwrap();
        let directory_link = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_eq!(directory_link.files[0].additions, Some(1));
        assert_eq!(directory_link.files[0].deletions, Some(1));
        let diff = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &directory_link.merge_base,
            "recreated",
            None,
        )
        .unwrap();
        assert!(!diff_contents(&diff).contains("must not appear"));

        fs::remove_file(fixture.path.join("recreated")).unwrap();
        symlink("../missing-target", fixture.path.join("recreated")).unwrap();
        let dangling = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_eq!(dangling.files[0].additions, Some(1));
        assert_eq!(dangling.files[0].deletions, Some(1));
        let dangling_diff = working_tree_file_diff(
            fixture.path.to_str().unwrap(),
            &dangling.merge_base,
            "recreated",
            None,
        )
        .unwrap();
        assert!(diff_contents(&dangling_diff).contains("missing-target"));
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn represents_embedded_repositories_and_changed_gitlinks_as_nontext() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        let nested = fixture.path.join("nested");
        fs::create_dir(&nested).unwrap();
        let nested_fixture = FixtureRepository { path: nested };
        nested_fixture.git(["init", "--quiet"]);
        nested_fixture.git(["config", "user.name", "Nested Tests"]);
        nested_fixture.git(["config", "user.email", "tests@example.invalid"]);
        nested_fixture.git(["commit", "--allow-empty", "-m", "nested base"]);

        let untracked = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let directory = untracked
            .files
            .iter()
            .find(|file| file.path == "nested/")
            .unwrap();
        assert!(directory.binary);

        fixture.git(["add", "nested"]);
        fixture.git(["commit", "-m", "add gitlink"]);
        nested_fixture.git(["commit", "--allow-empty", "-m", "nested change"]);
        let changed = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let gitlink = changed
            .files
            .iter()
            .find(|file| file.path == "nested")
            .unwrap();
        assert!(gitlink.binary);
        assert_eq!(gitlink.status, FileStatus::Modified);
        std::mem::forget(nested_fixture);
    }

    #[test]
    fn oversized_file_identity_changes_without_requiring_a_renderable_hash() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.write_bytes("large.bin", &vec![b'a'; MAX_RENDERABLE_DIFF_BYTES + 1]);
        let first = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        fixture.write_bytes("large.bin", &vec![b'a'; MAX_RENDERABLE_DIFF_BYTES + 2]);
        let second = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        assert_ne!(first.files[0].fingerprint, second.files[0].fingerprint);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_identity_changes_after_same_size_write_with_restored_mtime() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.write("timestamp-reference", "reference\n");
        fixture.write_bytes("large.bin", &vec![b'a'; MAX_RENDERABLE_DIFF_BYTES + 1]);
        let touch = |path: &Path| {
            let status = Command::new("touch")
                .args(["-r", "timestamp-reference"])
                .arg(path)
                .current_dir(&fixture.path)
                .status()
                .unwrap();
            assert!(status.success());
        };
        touch(Path::new("large.bin"));
        let first = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        fixture.write_bytes("large.bin", &vec![b'b'; MAX_RENDERABLE_DIFF_BYTES + 1]);
        touch(Path::new("large.bin"));
        let second = compare_working_tree(fixture.path.to_str().unwrap(), "main").unwrap();
        let first_file = first
            .files
            .iter()
            .find(|file| file.path == "large.bin")
            .unwrap();
        let second_file = second
            .files
            .iter()
            .find(|file| file.path == "large.bin")
            .unwrap();
        assert_ne!(first_file.fingerprint, second_file.fingerprint);
    }

    #[test]
    fn lists_feature_commits_newest_first() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.git(["commit", "--allow-empty", "-m", "first feature commit"]);
        fixture.git(["commit", "--allow-empty", "-m", "second feature commit"]);

        let merge_base = fixture.git(["rev-parse", "main"]);
        let compare_commit = fixture.git(["rev-parse", "feature"]);
        let commits =
            commits(fixture.path.to_str().unwrap(), &merge_base, &compare_commit).unwrap();

        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "second feature commit");
        assert_eq!(commits[1].subject, "first feature commit");
        assert_eq!(commits[0].id, compare_commit);
    }

    #[test]
    fn identifies_renamed_and_binary_files_in_a_real_repository() {
        let fixture = FixtureRepository::new();
        fixture.write("old name.txt", "same\nbefore\nstill same\n");
        fixture.git(["add", "old name.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.git(["mv", "old name.txt", "new name.txt"]);
        fixture.write("new name.txt", "same\nafter\nstill same\n");
        fixture.write_bytes("image.bin", &[0, 1, 2, 3, 255]);
        fixture.git(["add", "new name.txt", "image.bin"]);
        fixture.git(["commit", "-m", "rename and binary"]);

        let comparison = compare(fixture.path.to_str().unwrap(), "main", "feature").unwrap();
        let renamed = comparison
            .files
            .iter()
            .find(|file| file.path == "new name.txt")
            .unwrap();
        let binary = comparison
            .files
            .iter()
            .find(|file| file.path == "image.bin")
            .unwrap();

        assert_eq!(renamed.status, FileStatus::Renamed);
        assert_eq!(renamed.old_path.as_deref(), Some("old name.txt"));
        assert!(binary.binary);
        assert_eq!(binary.additions, None);
    }

    #[test]
    fn opens_a_repository_before_its_first_commit() {
        let fixture = FixtureRepository::new();
        let repository = open(fixture.path.to_str().unwrap()).unwrap();
        assert!(repository.branches.is_empty());
        assert_eq!(repository.current_branch, None);
        assert_eq!(repository.suggested_base_branch, None);
    }

    #[test]
    fn treats_magic_looking_filenames_as_literal_paths() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write(":!special.txt", "literal path\n");
        fixture.git(["add", "--", ":!special.txt"]);
        fixture.git(["commit", "-m", "add magic-looking path"]);

        let comparison = compare(fixture.path.to_str().unwrap(), "main", "feature").unwrap();
        let file = comparison
            .files
            .iter()
            .find(|file| file.path == ":!special.txt")
            .unwrap();
        let diff = file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            &comparison.compare_commit,
            &file.path,
            None,
        )
        .unwrap();
        assert_eq!(diff.hunks[0].lines[0].content, "literal path");
    }

    #[test]
    fn stops_collecting_a_patch_at_the_render_limit() {
        let fixture = FixtureRepository::new();
        fixture.git(["commit", "--allow-empty", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write(
            "large.txt",
            &"a reasonably long changed line\n".repeat(220_000),
        );
        fixture.git(["add", "large.txt"]);
        fixture.git(["commit", "-m", "large file"]);

        let comparison = compare(fixture.path.to_str().unwrap(), "main", "feature").unwrap();
        let diff = file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            &comparison.compare_commit,
            "large.txt",
            None,
        )
        .unwrap();
        assert!(diff.too_large);
        assert!(diff.hunks.is_empty());
    }

    #[test]
    fn disables_repository_configured_text_conversion() {
        let fixture = FixtureRepository::new();
        fixture.write(".gitattributes", "*.txt diff=danger\n");
        fixture.write("file.txt", "before\n");
        fixture.git(["add", ".gitattributes", "file.txt"]);
        fixture.git(["commit", "-m", "base"]);
        fixture.git(["branch", "-M", "main"]);
        fixture.git(["config", "diff.danger.textconv", "/usr/bin/false"]);
        fixture.git(["checkout", "-b", "feature"]);
        fixture.write("file.txt", "after\n");
        fixture.git(["add", "file.txt"]);
        fixture.git(["commit", "-m", "change text"]);

        let comparison = compare(fixture.path.to_str().unwrap(), "main", "feature").unwrap();
        let diff = file_diff(
            fixture.path.to_str().unwrap(),
            &comparison.merge_base,
            &comparison.compare_commit,
            "file.txt",
            None,
        )
        .unwrap();
        assert!(!diff.hunks.is_empty());
    }

    #[test]
    fn rejects_non_utf8_paths_instead_of_changing_them() {
        let error = parse_name_status(b"M\0bad-\xff-name\0").unwrap_err();
        assert!(error.to_string().contains("not valid UTF-8"));
    }

    struct FixtureRepository {
        path: PathBuf,
    }

    impl FixtureRepository {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "patchdeck-{}-{suffix}-{fixture_id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            let fixture = Self { path };
            fixture.git(["init", "--quiet"]);
            fixture.git(["config", "user.name", "Branch Diff Tests"]);
            fixture.git(["config", "user.email", "tests@example.invalid"]);
            fixture
        }

        fn write(&self, relative_path: &str, contents: &str) {
            fs::write(self.path.join(relative_path), contents).unwrap();
        }

        fn write_bytes(&self, relative_path: &str, contents: &[u8]) {
            fs::write(self.path.join(relative_path), contents).unwrap();
        }

        fn git<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            let output = Command::new("git")
                .arg("--literal-pathspecs")
                .arg("-C")
                .arg(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        }

        fn snapshot(&self) -> String {
            format!(
                "{}\n{}\n{}\n{}",
                self.git(["status", "--porcelain=v2", "--branch"]),
                self.git(["show-ref"]),
                self.git(["rev-parse", "HEAD"]),
                directory_digest(&self.path.join(".git"))
            )
        }
    }

    impl Drop for FixtureRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn directory_digest(root: &Path) -> u64 {
        fn collect(root: &Path, directory: &Path, records: &mut Vec<(PathBuf, Vec<u8>)>) {
            let mut entries: Vec<_> = fs::read_dir(directory)
                .unwrap()
                .map(Result::unwrap)
                .collect();
            entries.sort_by_key(|entry| entry.path());
            for entry in entries {
                let path = entry.path();
                if path.is_dir() {
                    collect(root, &path, records);
                } else {
                    records.push((
                        path.strip_prefix(root).unwrap().to_owned(),
                        fs::read(&path).unwrap(),
                    ));
                }
            }
        }

        let mut records = Vec::new();
        collect(root, root, &mut records);
        let mut hasher = DefaultHasher::new();
        records.hash(&mut hasher);
        hasher.finish()
    }

    fn diff_contents(diff: &FileDiff) -> String {
        diff.hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .map(|line| line.content.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
