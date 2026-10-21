# Skill Eval coverage live smoke test

Temporary isolated baseline for Azure/azure-sdk-tools PR #17345.

Only the reviewed coverage code, its two GitHub workflows, and their local test/lint dependencies are included. Checker and reporter source files are copied byte-for-byte from the reviewed feature commit. The repository-specific discovery configuration uses a synthetic skill fixture.

The test PR first adds a skill without an Eval, then adds one Eval. Expected results: a nonblocking missing-coverage report followed by coverage present, with one updated bot comment and the dashboard link in both versions. No model-backed Eval, Azure pipeline, publication, or deployment runs in this test.
