## feat(cherrystudio): track Cherry Studio usage

### Summary

Tracks [Cherry Studio](https://cherry-ai.com/) as a client. Cherry Studio's Agent / Claude Code mode writes standard Claude Code transcripts under its app-data directory; the underlying `tokscale` engine (this PR depends on the next tokscale release) parses and dedupes them, and this change wires the client into the widget's tracking, health checks, renderer, and docs.

### Changes

- `src/shared/clientTracking.js` — add `cherrystudio` to `DEFAULT_CLIENTS`
- `src/shared/collector.js` — source roots for both transcript locations: `<appdata>/CherryStudio/.claude/projects` (legacy) and `<appdata>/CherryStudio/Data/Agents/.claude/projects` (V2, current writes), on all three platforms; tokscale dedupes same-named sessions (V2 wins)
- `src/shared/clientHealth.js` (+ `worker/src/shared/` via `npm run sync:worker`) — `cherrystudio-transcripts` check id
- `src/shared/usage.js` — normalize `cherrystudio` client id
- Renderer: `clientLabels` / `clientsWithIcon` / `KNOWN_CLIENTS` (`app.js`), Discord RPC (`discordRpc.js`), `VENDOR_ORDER` / `VENDOR_LABELS` (`themePresets.js`), `clientColors` (`usageCharts.js`), row icon CSS, `assets/icons/cherrystudio.svg` + `.github/assets/tools-icon/cherrystudio.png`
- Docs: supported-tools table + counts in `README.md` and the ko/ja/zh-CN/zh-TW translations, `.env.example` client CSV
- `tests/docs/readmeConsistency.test.js` — supported tool/ID order entries

### Verification

- `npm run verify` — lint ✅; 2893/2894 tests pass; the single failure is the pre-existing Windows symlink-privilege test (`macWidgetLaunchServicesRecovery`, EPERM without admin — passes on CI)
- End-to-end: collector dry-run detects `cherrystudio` as an active client and aggregates its all-time usage (~30.5B tokens from live transcripts, matching `tokscale`'s own report)
- `npm run dist:win` — portable + NSIS builds succeed

### Notes

- Depends on tokscale adding the `cherrystudio` client (companion PR in `junhoyeo/tokscale`); this PR upgrades the `tokscale` dependency once the engine release lands.
- Cherry Studio's data source is its Claude Code transcripts (Agent / Claude Code mode only); regular chat mode produces no transcripts and is out of scope by design.
