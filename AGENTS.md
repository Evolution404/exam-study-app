# Project Agent Instructions

## Scope and project context

- These instructions apply to this repository and all of its subdirectories.
- Read `HANDOFF.md` before planning or modifying substantial functionality.
- Preserve unrelated user changes and configuration. Never revert another agent's work to make a patch apply.
- The main Agent owns task decomposition, cross-module decisions, integration, verification, and final delivery.

## Subagent scheduling

1. Prefer multiple `luna_worker` agents in parallel for substantial, mutually independent subtasks.
2. Keep lightweight work that can be completed in a few minutes in the main thread.
3. Every worker assignment must be self-contained and state the relevant context, owned files or directories, scope boundaries, expected output, and acceptance criteria.
4. Read-only investigations may run in parallel. Any task that writes files must use an independent Git worktree; if worktrees cannot safely isolate the changes, run the writing tasks serially.
5. The main Agent must check each worker's result against its stated acceptance criteria. Reassign or request corrections when the result does not pass.
6. If multiple workers cannot run concurrently, inspect `agents.max_concurrent_threads_per_session` in `~/.codex/config.toml` and verify that it is not set to `1`.

These scheduling rules apply to `luna_worker` and every other custom subagent.

## Worker task contract

- A writing worker owns only the files explicitly assigned to it and works only in the worktree named by the main Agent.
- Workers must not expand product scope, change the main task objective, publish, push, or alter external state unless the assignment explicitly authorizes it.
- Workers must account for concurrent development and must not delete, overwrite, or revert other contributors' edits.
- A worker's final report must list changed files, implemented behavior, validation commands and results, and remaining risks or blockers.

## Integration and verification

- The main Agent reviews diffs before integration and resolves cross-module design questions.
- Validate integrated behavior in proportion to risk, including focused tests first and the relevant full test/build checks before delivery.
- Do not mark a delegated task complete solely because a worker reports success; verify its output directly.
