# Agent resources

`AGENTS.md` at the repository root is the primary project guide. This directory keeps focused instructions that agents can load only when the task needs them.

## Contents

- `agents/vault-security-reviewer.md` reviews filesystem, command, authentication, and resource-limit changes.
- `commands/release.md` defines the local release preparation procedure.
- `rules/tests-and-scripts.md` explains the test setup and bridge code generation.
- `settings.json` records the shared command permission policy inherited from the previous project configuration.
- `skills/I-Have ADHD/SKILL.md` formats output for a reader with ADHD when explicitly enabled.
- `skills/unslop/SKILL.md` removes common AI writing patterns and is always applicable to project prose.

The skill copies came from `C:/Synology drive/Pessoal/SynologyDrive/Projetos/Skills`. Keep each skill self-contained so a checkout does not depend on files outside the repository.
