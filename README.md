# Order Execution Gateway

Electron application that executes trading orders received from various sources
through pluggable adapters. Order cards remain in the interface after an order
is placed and collapse to a header with a colored status dot that reflects the
position lifecycle:

- **blue** – order placed, waiting for fill
- **yellow** – position opened
- **green/red** – position closed in profit/loss

A lightweight event bus emits `order:placed`, `position:opened`,
`position:closed` and `order:cancelled` so other parts of the app can
react to changes.

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

### Obsidian integration
- `OBSIDIAN_INDEPSTATE_VAULT` – path to the Obsidian vault used for deal notes
- `OBSIDIAN_INDEPSTATE_DEALS_JOURNAL` – directory within the vault where notes are written

### Order cards
- `DEFAULT_EQUITY_STOP_USD` – default dollar amount to pre-fill the Risk $ field on equity cards

## Documentation

See [docs/](docs/README.md) for an overview of the codebase and
additional documentation.

