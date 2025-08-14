# Order Execution Gateway

Electron application that executes trading orders received from various sources
through pluggable adapters. Order cards remain in the interface after an order
is placed and collapse to a header with a colored status dot that reflects the
position lifecycle:

- **orange** – order placed, waiting for fill
- **blue** – position opened
- **green/red** – position closed in profit/loss

A lightweight event bus emits `order:placed`, `position:opened` and
`position:closed` so other parts of the app can react to changes.

## Environment variables

The application uses environment variables to supply credentials for execution providers.

### J2T provider
- `J2T_ACCOUNT_ID` – account identifier
- `J2T_TOKEN` – API token

### DWX provider
- `DWX_HOST` – DWX bridge host
- `DWX_PORT` – port for the bridge
- `DWX_ACCOUNT` – trading account number
- `DWX_PASSWORD` – password for the trading account

## Documentation

See [docs/](docs/README.md) for an overview of the codebase and
additional documentation.

