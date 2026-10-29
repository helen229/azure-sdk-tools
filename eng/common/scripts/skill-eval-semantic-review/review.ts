import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gitSnapshot } from "../skill-eval-coverage/check.ts";
import { checkCoverage, CONFIG_PATH, parseConfig } from "../skill-eval-coverage/coverage.ts";
import type { RepositorySnapshot, SkillCoverage } from "../skill-eval-coverage/coverage.ts";

export const MAX_INPUT_BYTES = 48 * 1024;
export const MAX_SOURCE_BYTES = 12 * 1024;
export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_REFERENCE_FILES = 8;
export const RUBRIC = { representation: 40, assertions: 30, negativeCases: 20, alignment: 10 } as const;
export const RUBRIC_VERSION = "semantic-quality-pilot/v1";
const MAX_SOURCES = 24;
const MAX_CAPABILITIES = 20;
const { parseDocument } = createRequire(new URL("../skill-eval-coverage/package.json", import.meta.url))("yaml");

export interface Source {
    path: string;
    role: "skill" | "eval" | "reference" | "configuration";
    lines: { line: number; text: string }[];
}

export interface ReviewInput {
    schema: "semantic-input/v1";
    skill: string;
    repository: string;
    revision: string;
    rubric: typeof RUBRIC;
    rubricVersion: string;
    presence: SkillCoverage | null;
    problems: string[];
    files: Source[];
    inputHash: string;
}

interface Evidence { path: string; line: number; quote: string }
interface Component { points: number; reason: string; evidence: Evidence[] }
interface Capability {
    name: string;
    status: "appears-covered" | "partial" | "possible-gap" | "inconclusive";
    reason: string;
    evidence: Evidence[];
    suggestions: { scenario: string; assertion: string }[];
}

export interface SemanticReport {
    schema: "semantic-review/v1";
    skill: string;
    revision: string;
    inputHash: string;
    status: "assessed" | "inconclusive";
    summary: string;
    limitations: string[];
    capabilities: Capability[];
    scores: Record<keyof typeof RUBRIC, Component> | null;
    total: number | null;
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum = 2000): asserts value is string {
    assert(typeof value === "string" && value.trim().length > 0 && value.length <= maximum,
        "Expected a bounded, nonempty string.");
}

function repository(value: string): string {
    assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), "Expected owner/repository.");
    return value;
}

function encoded(input: unknown): string {
    return JSON.stringify(input);
}

export async function buildInput(
    snapshot: RepositorySnapshot, skill: string, revision: string, repo: string,
): Promise<ReviewInput> {
    assert(/^[a-z0-9][a-z0-9-]{0,99}$/.test(skill), "Expected one skill directory name.");
    assert(/^[a-f0-9]{40}$/.test(revision), "Expected an immutable source commit.");
    repository(repo);
    const configText = await snapshot.read(CONFIG_PATH);
    assert(configText, "Coverage configuration is unavailable.");
    const config = parseConfig(configText);
    const directory = `${config.skillsRoot}/${skill}/`;
    const skillFile = directory + "SKILL.md";
    const coverage = await checkCoverage(snapshot, config, [skillFile]);
    const presence = coverage.skills.find((item) => item.name === skill && item.status !== "deleted") ?? null;
    const input: ReviewInput = {
        schema: "semantic-input/v1", skill, repository: repo, revision, rubric: RUBRIC,
        rubricVersion: RUBRIC_VERSION, presence, problems: [], files: [], inputHash: "",
    };
    if (!presence) input.problems.push("The selected skill is absent from the source revision.");
    for (const issue of presence?.issues ?? []) {
        if (!issue.startsWith("No associated Eval with")) input.problems.push(issue);
    }
    const entries = new Map(snapshot.files.map((file) => [file.path, file]));
    const candidates: { path: string; role: Source["role"] }[] = [{ path: skillFile, role: "skill" }];
    for (const file of presence?.evals ?? []) candidates.push({ path: file, role: "eval" });
    for (const file of [config.skillsRoot + "/.vally.yaml", directory + ".vally.yaml"]) {
        if (entries.has(file)) candidates.push({ path: file, role: "configuration" });
    }
    const references = [...entries.keys()].filter((file) => file.startsWith(directory) &&
        file !== skillFile && file.endsWith(".md") &&
        !file.slice(directory.length).split("/").some((part) => ["evals", "fixtures"].includes(part))).sort();
    if (references.length > MAX_REFERENCE_FILES) input.problems.push("Reference document limit exceeded; evidence is incomplete.");
    for (const file of references.slice(0, MAX_REFERENCE_FILES)) candidates.push({ path: file, role: "reference" });
    if (candidates.length > MAX_SOURCES) input.problems.push("Source file limit exceeded; evidence is incomplete.");
    for (const candidate of candidates.slice(0, MAX_SOURCES)) {
        const entry = entries.get(candidate.path);
        if (!entry || !["100644", "100755"].includes(entry.mode) || (entry.size ?? 0) > MAX_SOURCE_BYTES) {
            input.problems.push(`Source must be a regular file of at most ${MAX_SOURCE_BYTES} bytes: ${candidate.path}`);
            continue;
        }
        const source = await snapshot.read(candidate.path);
        if (source === undefined || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
            input.problems.push(`Source is unavailable or oversized: ${candidate.path}`);
            continue;
        }
        const file: Source = { ...candidate, lines: source.replace(/\r\n/g, "\n").split("\n")
            .map((text, index) => ({ line: index + 1, text })) };
        const proposed = { ...input, files: [...input.files, file] };
        if (Buffer.byteLength(encoded(proposed), "utf8") > MAX_INPUT_BYTES - 2048) {
            input.problems.push(`Input byte limit exceeded; source excluded: ${candidate.path}`);
            continue;
        }
        input.files.push(file);
    }
    input.inputHash = createHash("sha256").update(encoded(input)).digest("hex");
    assert(Buffer.byteLength(encoded(input), "utf8") <= MAX_INPUT_BYTES, "Input exceeds its byte limit.");
    return input;
}

function evidence(value: unknown, input: ReviewInput): asserts value is Evidence[] {
    assert(Array.isArray(value) && value.length >= 1 && value.length <= 8, "Expected 1-8 source citations.");
    for (const citation of value) {
        assert(record(citation), "Expected a source citation.");
        text(citation.path, 4096);
        text(citation.quote, 500);
        assert(Number.isInteger(citation.line) && Number(citation.line) >= 1, "Expected a positive source line.");
        const source = input.files.find((file) => file.path === citation.path);
        assert(source, "Citation references a file outside the supplied snapshot.");
        const line = source.lines[Number(citation.line) - 1]?.text;
        assert(typeof line === "string" && !/[\r\n]/.test(citation.quote) && line.includes(citation.quote),
            `Citation quote does not match ${citation.path}:${citation.line}; use an exact substring.`);
    }
}

export function parseReport(value: unknown, input: ReviewInput): SemanticReport {
    text(value, MAX_REPORT_BYTES);
    assert(Buffer.byteLength(value, "utf8") <= MAX_REPORT_BYTES, "Report exceeds its byte limit.");
    const document = parseDocument(value, { version: "1.2", schema: "core", uniqueKeys: true });
    const issue = document.errors[0] ?? document.warnings[0];
    assert(document.errors.length === 0 && document.warnings.length === 0,
        "Expected one valid data-only YAML or JSON report, without duplicate keys or custom tags. " +
        (issue ? String(issue.message).split("\n")[0] : ""));
    let parsed: unknown;
    try { parsed = document.toJS({ maxAliasCount: 0 }); }
    catch { throw new assert.AssertionError({ message: "Report aliases are not allowed." }); }
    return validateReport(parsed, input);
}

export function validateReport(value: unknown, input: ReviewInput): SemanticReport {
    assert(Buffer.byteLength(encoded(value) ?? "", "utf8") <= MAX_REPORT_BYTES, "Report exceeds its byte limit.");
    assert(record(value) && value.schema === "semantic-review/v1", "Expected a semantic-review/v1 report.");
    assert(value.skill === input.skill && value.revision === input.revision && value.inputHash === input.inputHash,
        "Report does not match the immutable input identity.");
    assert(value.status === "assessed" || value.status === "inconclusive", "Expected an explicit assessment status.");
    text(value.summary);
    assert(Array.isArray(value.limitations) && value.limitations.length <= 12, "Expected bounded limitations.");
    value.limitations.forEach((limitation) => text(limitation));
    assert(Array.isArray(value.capabilities) && value.capabilities.length <= MAX_CAPABILITIES,
        "Expected a bounded capability assessment.");
    for (const capability of value.capabilities) {
        assert(record(capability), "Expected a capability assessment.");
        text(capability.name, 200);
        text(capability.reason);
        assert(["appears-covered", "partial", "possible-gap", "inconclusive"].includes(String(capability.status)),
            "Expected a declared capability status.");
        evidence(capability.evidence, input);
        assert(capability.evidence.some((citation) => input.files.some((file) =>
            file.path === citation.path && ["skill", "reference"].includes(file.role))),
        "A capability needs a cited declaration, not just Eval metadata.");
        if (["appears-covered", "partial"].includes(String(capability.status))) {
            const citations = capability.evidence.filter((citation) => input.files.some((file) =>
                file.path === citation.path && file.role === "eval"));
            assert(new Set(citations.map((citation) => `${citation.path}:${citation.line}`)).size >= 2,
                `Represented coverage needs separate Eval scenario and assertion citations for ${capability.name}.`);
        }
        assert(Array.isArray(capability.suggestions) && capability.suggestions.length <= 3,
            "Expected bounded scenario/assertion suggestions.");
        for (const suggestion of capability.suggestions) {
            assert(record(suggestion), "Expected a concrete scenario and assertion.");
            text(suggestion.scenario);
            text(suggestion.assertion);
        }
        if (["partial", "possible-gap"].includes(String(capability.status))) {
            assert(capability.suggestions.length > 0, "Partial coverage and gaps need a concrete suggested test.");
        }
    }
    if (value.status === "inconclusive") {
        assert(value.scores === null && value.total === null && value.limitations.length > 0,
            "Inconclusive evidence cannot receive a numeric score.");
    } else {
        assert(input.problems.length === 0 && value.capabilities.length > 0 &&
            value.capabilities.every((capability) => capability.status !== "inconclusive"),
        "Incomplete input or capability evidence cannot receive an assessed score.");
        assert(record(value.scores) && Object.keys(value.scores).length === Object.keys(RUBRIC).length,
            "Expected all four rubric components.");
        let total = 0;
        for (const [name, maximum] of Object.entries(RUBRIC)) {
            const component = value.scores[name];
            assert(record(component) && Number.isInteger(component.points) &&
                Number(component.points) >= 0 && Number(component.points) <= maximum,
            "Rubric points are outside their component range.");
            text(component.reason);
            evidence(component.evidence, input);
            total += Number(component.points);
        }
        assert(Number.isInteger(value.total) && value.total === total, "Score total does not equal its components.");
        if (!input.presence?.evals.length) assert(total === 0, "An empty Eval inventory cannot earn coverage quality points.");
    }
    return value as unknown as SemanticReport;
}

export function preflightReport(value: unknown, input: ReviewInput): { valid: boolean; error?: string } {
    try { parseReport(value, input); return { valid: true }; }
    catch (error) {
        const message = error instanceof assert.AssertionError ? error.message : "Report decoding failed.";
        return { valid: false, error: message.replace(/[\r\n]/g, " ").slice(0, 180) };
    }
}

function escape(value: string): string {
    return value.replace(/[&<>"'`*_\[\]\\|@]/g, (character) => `&#${character.charCodeAt(0)};`)
        .replace(/\r?\n/g, " ");
}

export function renderReport(report: SemanticReport, input: ReviewInput): string {
    repository(input.repository);
    const citation = (item: Evidence) => {
        const file = item.path.split("/").map(encodeURIComponent).join("/");
        return `[${escape(item.path)}:${item.line}](https://github.com/${input.repository}/blob/${input.revision}/${file}#L${item.line})`;
    };
    const lines = ["### Advisory Semantic Eval Review", "",
        "> [!NOTE]", "> AI-generated, uncalibrated quality estimate. Not a measured coverage percentage or a merge gate.",
        "> No behavioral Evals were executed. Citation validation does not establish semantic correctness.", "",
        `**Skill:** ${escape(input.skill)}`, `**Status:** ${escape(report.status)}`,
        `**Quality estimate:** ${report.total === null ? "Inconclusive (no score)" : `${report.total}/100`}`, "",
        escape(report.summary), ""];
    if (report.scores) {
        lines.push("| Component | Points | Explanation |", "| --- | --- | --- |");
        for (const [name, maximum] of Object.entries(RUBRIC)) {
            const component = report.scores[name as keyof typeof RUBRIC];
            lines.push(`| ${name} | ${component.points}/${maximum} | ${escape(component.reason)} ${component.evidence.map(citation).join(", ")} |`);
        }
    }
    for (const capability of report.capabilities) {
        lines.push("", `#### ${escape(capability.name)}: ${capability.status}`, "", escape(capability.reason), "",
            capability.evidence.map(citation).join(", "));
        for (const suggestion of capability.suggestions) {
            lines.push("", `**Suggested scenario:** ${escape(suggestion.scenario)}`,
                `**Expected assertion:** ${escape(suggestion.assertion)}`);
        }
    }
    if (report.limitations.length || input.problems.length) {
        lines.push("", "### Limitations", "", ...[...report.limitations, ...input.problems].map((item) => `- ${escape(item)}`));
    }
    lines.push("", `**Source revision:** ${input.revision}`, `**Input SHA-256:** ${input.inputHash}`,
        `**Rubric:** ${RUBRIC_VERSION}`, "");
    return lines.join("\n");
}

function readJson(file: string, maximum: number): unknown {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, "Expected a bounded regular JSON file.");
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { throw new Error("Could not parse the structured review output."); }
}

export async function main(argv: string[]): Promise<void> {
    const mode = argv[0];
    if (mode === "preflight") {
        assert(argv.length === 1 && process.env.SEMANTIC_INPUT_FILE, "Preflight requires a prepared input file.");
        const input = readJson(process.env.SEMANTIC_INPUT_FILE, MAX_INPUT_BYTES);
        assert(record(input) && input.schema === "semantic-input/v1" && Array.isArray(input.files), "Expected a prepared input snapshot.");
        const hash = createHash("sha256").update(encoded({ ...input, inputHash: "" })).digest("hex");
        assert(input.inputHash === hash, "Prepared input identity does not match its contents.");
        process.stdout.write(encoded(preflightReport(process.env.INPUT_REPORT, input as unknown as ReviewInput)) + "\n");
        return;
    }
    assert(mode === "prepare" || mode === "report", "Choose prepare, preflight or report.");
    const { values } = parseArgs({ args: argv.slice(1), options: {
        "repo-root": { type: "string", default: "." }, revision: { type: "string" },
        skill: { type: "string" }, repository: { type: "string" }, "agent-output": { type: "string" },
        "output-dir": { type: "string" },
    } });
    const root = path.resolve(values["repo-root"]!);
    const ref = values.revision ?? process.env.GITHUB_SHA ?? "HEAD";
    const revision = execFileSync("git", ["-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1024 }).trim();
    const skill = values.skill ?? process.env.SEMANTIC_SKILL ?? "";
    const repo = values.repository ?? process.env.GITHUB_REPOSITORY ?? "";
    const input = await buildInput(gitSnapshot(root, revision), skill, revision, repo);
    if (mode === "prepare") {
        const json = encoded(input);
        if (values["output-dir"]) {
            fs.mkdirSync(values["output-dir"], { recursive: true });
            fs.writeFileSync(path.join(values["output-dir"], "input.json"), json + "\n");
        }
        if (process.env.GITHUB_ACTIONS === "true") {
            assert(process.env.GITHUB_OUTPUT, "GitHub output path is unavailable.");
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `snapshot=${json}\n`);
        } else process.stdout.write(json + "\n");
        return;
    }
    const outputFile = values["agent-output"] ?? process.env.GH_AW_AGENT_OUTPUT;
    assert(outputFile, "Agent output is unavailable; no report was produced.");
    const output = readJson(outputFile, 1024 * 1024);
    assert(record(output) && Array.isArray(output.items) && output.items.length === 1,
        "Expected exactly one structured semantic report output.");
    const item = output.items[0];
    assert(record(item) && item.type === "semantic_report", "Expected the semantic_report output type.");
    const report = parseReport(item.report, input);
    const markdown = renderReport(report, input);
    const directory = values["output-dir"] ?? path.join(process.env.RUNNER_TEMP ?? "", "skill-eval-semantic-review");
    assert(values["output-dir"] || process.env.RUNNER_TEMP, "An output directory is required outside Actions.");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "report.json"), encoded({
        report, provenance: { repository: input.repository, revision, inputHash: input.inputHash,
            rubricVersion: RUBRIC_VERSION, runId: process.env.GITHUB_RUN_ID ?? null,
            runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null },
    }) + "\n");
    fs.writeFileSync(path.join(directory, "report.md"), markdown);
    if (process.env.GITHUB_ACTIONS === "true") {
        assert(process.env.GITHUB_STEP_SUMMARY, "GitHub summary path is unavailable.");
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    }
    process.stdout.write("Validated advisory report saved. No behavioral Evals were executed.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof assert.AssertionError ? error.message : "Semantic review could not produce a validated report.");
        process.exitCode = 1;
    });
}
