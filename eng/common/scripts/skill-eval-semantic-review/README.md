# Skill Eval semantic review pilot

A separate, manual GitHub agentic workflow uses an LLM to compare a skill's declared
capabilities with its actual Eval prompts, conversation turns, and grader assertions.
It produces concrete missing scenarios and expected assertions, source citations,
and an explained advisory quality estimate. It does not execute behavioral Evals.

This is not the deterministic presence check in [PR 17345](https://github.com/Azure/azure-sdk-tools/pull/17345),
nor its warning-to-error activation in [issue 17402](https://github.com/Azure/azure-sdk-tools/issues/17402).
The pilot depends on the presence check's data-only Git/YAML helpers. Keep both
script directories and the presence configuration together when testing it.

## Report contract

Each manual run reviews one skill at the run's immutable commit. Preparation reuses
the presence check's discovery rules, reads Git blobs rather than working files,
and supplies numbered source lines, optional local Markdown references and Vally
configuration. Skill instructions and Eval bodies are data, never agent instructions.
There is no remote URL fetching, SDK operation, package release, or Eval execution.

Inputs are limited to 48 KiB, 12 KiB per source, 24 sources, and 8 reference documents.
Unavailable, malformed, linked, oversized, or excluded required evidence is recorded
as incomplete. Essential references outside the snapshot also require the model to
declare the review inconclusive. An incomplete input cannot receive a numeric score.
Neither can a report with any capability marked inconclusive.
An otherwise complete skill with no Evals has an explicit gap and a score of zero.

The `semantic-review/v1` report contains capability assessments, exact `path`/`line`/
`quote` citations, concrete `scenario`/`assertion` suggestions, limitations, and these
uncalibrated rubric components:

| Component | Maximum | Meaning |
| --- | --- | --- |
| `representation` | 40 | Explicit core workflow/scenario representation |
| `assertions` | 30 | Checks that distinguish correct from incorrect outcomes |
| `negativeCases` | 20 | Meaningful refusal, failure and edge-case assertions |
| `alignment` | 10 | Agreement with skill triggers, tools and declared contracts |

The report handler verifies input identity, component ranges and arithmetic, actual
citation text/lines, and actionable suggestions for partial/gap findings. It rejects
duplicate reports and unsupported evidence. These structural checks do not prove
that the LLM's interpretation or score is correct. The score is a quality estimate,
not measured coverage, exhaustive analysis, proof of passing Evals, or a merge gate.

## Workflow and safety

[Workflow source](../../../../.github/workflows/skill-eval-semantic-review.md) is
compiled by the official `github/gh-aw` **v1.0.1** compiler. Commit the generated
`.lock.yml`, action-pin metadata, and generated-file attributes with the source;
never hand-edit generated pins or YAML. The existing offline script-test workflow
recompiles and checks for drift without invoking inference.

The agent has no checkout, GitHub tools, shell/edit tools, web tools, or ambient
repository instructions. Network access is restricted by the framework. Its sole
domain tool submits a report to a separate data-validation job. All jobs have no
GitHub write scopes; automatic issue, comment, missing-data and failure publication
are explicitly disabled, including threat-detection reporting. The framework's
threat detector stays enabled and fail-closed. A final job requires a successfully
validated report; a missing report is not a successful assessment.

Outputs are an Actions step summary and the seven-day
`skill-eval-semantic-review` artifact (`report.md`, `report.json`). Provenance includes
repository, immutable source revision, input SHA-256, rubric version, run ID and
attempt. Actual engine/model and usage evidence remain in the framework artifacts;
do not infer the executed model or dollar cost from the model's own response.

The requested model is `gpt-5.4-mini`, with 6 agent turns, 8 execution minutes,
50 agent AI credits and 20 detection AI credits configured. These are framework
controls, not a separately verified total-spend guarantee. Actual model access,
reported cost, and hosted enforcement must be checked in the first real run.

The repository pins actionlint 1.7.12. Its two unsupported gh-aw extension fields
(`concurrency.queue`, `job.workflow_ref`) have exact, generated-file-only syntax
exceptions. All other rules remain active; strict gh-aw compilation also runs in CI.

## Local checks

Requires Node 24.14.1+ and the existing presence package's frozen dependency restore.
The semantic directory adds no dependencies or package-manager install of its own.
Use the presence README's pinned pnpm setup, then run from the repository root:

```powershell
node --test eng/common/scripts/skill-eval-coverage/test/*.test.ts eng/common/scripts/skill-eval-semantic-review/test/*.test.ts
node eng/common/scripts/skill-eval-semantic-review/review.ts prepare --skill azsdk-common-prepare-release-plan --repository OWNER/REPO
gh extension install github/gh-aw --pin v1.0.1
gh aw compile skill-eval-semantic-review --strict --no-check-update --no-logo
```

`prepare` prints JSON locally. In Actions it writes a single bounded job output.
`report --agent-output PATH --output-dir DIRECTORY` accepts only the framework's
single-item `semantic_report` envelope and re-reads the immutable Git evidence before
writing output. Local commands do not update a GitHub summary unless actually running
under Actions. Unit tests include a temporary Git repository and real CLI subprocesses;
they do not call a model or execute the supplied skill text.

## Personal-fork trial

1. Publish only to an explicitly approved personal fork. Do not change upstream,
   repository protections, Actions policy, default-branch selection, or production
   workflows. This local prototype does not publish or change those settings.
2. A personal fork needs a user-owned fine-grained PAT with **Account permissions >
   Copilot Requests: Read**, stored directly in GitHub Actions secrets as
   `COPILOT_GITHUB_TOKEN`. Never paste a token into chat or logs, reuse the GitHub CLI
   OAuth token, or assume organization `copilot-requests: write` billing is available.
3. GitHub requires the manual workflow to be available on the fork's default branch.
   Make that available only through an explicitly approved fork change. Do not swap
   the fork's default branch or replace its main history to bypass this prerequisite.
   `gh aw trial --host-repo` can also modify the host and prompt for secrets; it is
   not a read-only workaround and is not run automatically by these scripts.
4. Dispatch the reviewed fork revision with the `skill` input. Start with
   `azsdk-common-prepare-release-plan`, `azsdk-common-generate-sdk-locally`, and
   `azsdk-common-generate-sdk-pipeline` (the committed missing-Eval example).
5. In isolated fork revisions, remove a meaningful grader and replace one with an
   unrelated substring. Confirm the report names the exact missing outcome check,
   proposes a discriminating assertion, and does not award unchanged assertion
   quality. Include an injection-like instruction in data and verify no commands,
   external reads, GitHub writes, or instruction-following occur.
6. Repeat one unchanged input to assess score/explanation stability against a human
   review. Record run URL, commit, input hash, actual model, feedback, and available
   usage/cost. Missing cost is unknown, not zero. Do not claim semantic calibration
   from mock reports or offline tests.

The pilot is advisory and manual only. Automatic PR comments, required checks,
production rollout, rubric thresholds and scheduled/model-consuming runs are out of
scope until real fork evidence and human calibration justify a separate change.
