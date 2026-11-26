# Upstream provenance

Codex Plugin for Antigravity is an independent community port. OpenAI and Google do not publish or endorse it.

- Source baseline: [openai/codex-plugin-cc v1.0.6](https://github.com/openai/codex-plugin-cc/tree/db52e28f4d9ded852ab3942cea316258ae4ef346), commit `db52e28f4d9ded852ab3942cea316258ae4ef346`.
- Protocol audit reference: [openai/codex](https://github.com/openai/codex/tree/af71942309704997f4bdc86c020717646423c080), commit `af71942309704997f4bdc86c020717646423c080`. Protocol bindings are generated from Codex CLI 0.172.0.
- `src/upstream/{args,fs,git,prompts,workspace}.mjs` map to `plugins/codex/scripts/lib/` in the pinned tree. Local changes are marked `[codex-plugin-agy]`.
- `prompts/` and `schemas/review-output.schema.json` retain the corresponding upstream prompt and schema files. The Stop prompt uses Antigravity terminology.
- `LICENSE` is from the upstream repository. `NOTICE` preserves the OpenAI copyright notice.

When updating, review upstream changes in a separate clone, compare the files listed in the porting matrix, and reapply the marked patches. Regenerate bindings with `npm run generate:protocol`, then run type checking, tests, package validation and the security checks.
