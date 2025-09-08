# Auto-updater service

The auto-updater checks GitHub releases for new versions and applies them automatically.

## Configuration

Edit `app/services/autoUpdater/config/auto-updater.json`:

```json
{
  "enabled": true,
  "autoDownload": true,
  "allowPrerelease": false,
  "provider": "github",
  "owner": "detsam",
  "repo": "indepstate-cc"
}
```

- `enabled` – disable to skip update checks.
- `autoDownload` – download updates without prompting.
- `allowPrerelease` – allow updating to prerelease versions (e.g. `1.0.0-beta.1`).
- `provider`, `owner`, `repo` – GitHub repository hosting releases.

## Using the service

The service is registered in `app/services/settings/config/services.json` and starts once the app is ready. On download it calls `quitAndInstall()` to apply the update.

## Building releases

```bash
npm run build   # build Windows installer locally
npm run release # build and publish Windows installer to GitHub
```

Before running `npm run release`:

1. Set the `GH_TOKEN` environment variable to a GitHub token with `repo` scope.
2. If publishing to a different repository, update `owner` and `repo` in `package.json` and `app/services/autoUpdater/config/auto-updater.json`.

To publish a prerelease, set the package `version` to include a prerelease tag (e.g. `1.0.0-beta.1`) before running `npm run release`. Clients opt-in to prereleases by setting `allowPrerelease` to `true` in `auto-updater.json`.
