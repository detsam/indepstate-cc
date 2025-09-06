# Execution Adapters

The adapter registry builds and caches execution connectors based on entries in `app/config/execution.json`.
Copy this file to the `config` directory under the application's user data path to override the bundled defaults.

Each provider entry selects an adapter implementation and its settings.
Use `getAdapter(name)` to obtain a ready-to-use instance and `getProviderConfig(name)` to read raw configuration.
