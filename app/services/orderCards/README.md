# Order Cards Service

Loads order card definitions from pluggable sources.

## Configuration

Sources are defined in `app/config/order-cards.json`.
Copy this file to `config/order-cards.json` to override the defaults.

Each entry declares a `type` and options.

### Source types

- `webhook` – accepts rows parsed by the [webhooks service](../webhooks/README.md).
- `file` – watches a JSON file and emits cards when it changes.
