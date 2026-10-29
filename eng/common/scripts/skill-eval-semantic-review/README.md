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

The report tool transports one bounded, data-only YAML document; valid JSON remains
accepted for saved reports. Duplicate keys, aliases, custom tags, multiple documents,
invalid citations and invalid score arithmetic are rejected.

## Workflow and safety

[Workflow source](../../../../.github/workflows/skill-eval-semantic-review.md) is
compiled by the official `github/gh-aw` **v1.0.1** compiler. Commit the generated
`.lock.yml`, action-pin metadata, and generated-file attributes with the source;
never hand-edit generated pins or YAML. The existing offline script-test workflow
recompiles and checks for drift without invoking inference.

The agent has no checkout, GitHub tools, shell/edit tools, web tools, or ambient
repository instructions. Network access is restricted by the framework. Its domain
tools are a read-only `validate_semantic_report` preflight and final `semantic_report`
submission to a separate data-validation job. The preflight uses only the prepared
snapshot and trusted validator code staged by deterministic setup. It has no secrets,
network calls, file writes, or arbitrary-command inputs. The final job independently
revalidates submitted text; a successful preflight is not a publication authority.
All jobs have no
GitHub write scopes; automatic issue, comment, missing-data and failure publication
are explicitly disabled, including threat-detection reporting. The framework's
threat detector stays enabled and fail-closed. A final job requires a successfully
validated report; a missing report is not a successful assessment.

Outputs are an Actions step summary and the seven-day
`skill-eval-semantic-review` artifact (`report.md`, `report.json`). Provenance includes
repository, immutable source revision, input SHA-256, rubric version, run ID and
attempt. Actual engine/model and usage evidence remain in the framework artifacts;
do not infer the executed model or dollar cost from the model's own response.

The candidate model is `gpt-5.6-terra`, with 6 agent turns, 8 execution minutes,
50 agent AI credits and 20 detection AI credits configured. These are framework
controls, not a separately verified total-spend guarantee. Actual hosted model access,
reported cost, and hosted enforcement must be checked in the first GitHub run. Local
trials verified this model through the Copilot SDK; they do not establish its
availability for a different account or Actions policy.

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

## Local model rehearsal

The local runner uses the workflow's exact domain prompt, model selection, tool
descriptions, immutable snapshot builder, read-only preflight, and deferred report
validator. It uses standard existing Copilot CLI authentication, without reading,
printing, or extracting a token. Inference is hosted by Copilot, not an offline model.
Only the two review tools are enabled; ambient instructions and built-in MCPs are
disabled. Preflight is limited to three drafts. The session is explicitly aborted
after a report is queued or the validation limit is reached, with a forced-stop
fallback. A queued report is not successful until the actual report CLI accepts it.

Install the exact local runtime outside the repository, then use a new result directory:

```powershell
$runtime = Join-Path $env:TEMP 'semantic-review-runtime'
npm.cmd install --prefix $runtime --no-save --no-package-lock --ignore-scripts --no-audit --no-fund @github/copilot-sdk@1.0.28 @github/copilot@1.0.80
$results = Join-Path $env:TEMP ('semantic-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node eng/common/scripts/skill-eval-semantic-review/local.ts --runtime-root $runtime --output-dir $results --skill azsdk-common-prepare-release-plan --repository OWNER/REPO
```

The runner saves the input, full prompt, workflow/prompt hashes, draft and submitted
data, a receipt with actual model/usage and requested tools, and validated report
files. Existing result directories are never overwritten. `--model` explicitly
overrides the workflow's model and is disclosed in the receipt. The preparation and
validation code is the current local candidate; cited skill/Eval content comes from
the selected immutable `--revision` (default `HEAD`), not uncommitted skill edits.

Local runs do not reproduce the framework system prompt, safe-output service,
threat detector, Actions network sandbox, hosted authentication, or artifact service.
They cannot certify production readiness or safety against all prompt injections.

The 2026-10-29 local trial exercised eight real-inference cases: release-plan and SDK
generation skills, complete no-Eval inventory, stronger/weakened graders, injected
source instructions, excluded required evidence, and an unchanged-input repeat.
The grader pair reduced quality from 69 to 43; the no-Eval case scored zero and
excluded evidence received no score. The release-plan repeat changed from 55 to
inconclusive because the supplied skill/reference disagree about identifier handling.
Treat this as a manual advisory pilot with human review, not a stable score threshold.

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
