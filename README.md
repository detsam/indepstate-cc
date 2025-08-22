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

## Configuration

Default configuration files live in `app/config/`. To customize any of them,
copy the file to a `config/` directory in the project root and adjust as needed.
On startup the application deep‑merges local overrides onto the bundled
defaults.

Example:

```bash
mkdir -p config
cp app/config/order-cards.json config/order-cards.json
```

Notable configuration files include:

- [`app/config/execution.json`](app/config/execution.json) – execution providers and adapter settings. Environment variables can be interpolated with the `${ENV:VAR}` syntax.
- [`app/config/order-cards.json`](app/config/order-cards.json) – sources for incoming order cards and default card options.
- [`app/config/trade-rules.json`](app/config/trade-rules.json) – validation rules applied before orders are sent.

## Environment variables

Some configuration values, especially credentials, are supplied via environment variables:

### Execution providers
- `J2T_ACCOUNT_ID` – J2T account identifier.
- `J2T_TOKEN` – J2T API token.
- `DWX_SOCKET_DIR` – path to the DWX bridge directory.
- `BINANCE_API_KEY` – Binance API key.
- `BINANCE_API_SECRET` – Binance API secret.
- `BINANCE_API_TESTNET` – truthy to enable the Binance testnet.

### Obsidian integration
- `OBSIDIAN_INDEPSTATE_VAULT` – path to the Obsidian vault used for deal notes.
- `OBSIDIAN_INDEPSTATE_DEALS_JOURNAL` – directory within the vault where notes are written.
- `OBSIDIAN_INDEPSTATE_DEALS_SEARCH` – optional directory to search for existing notes to avoid duplicates.

#### Chart images

https://chart-img.com/

- `TV_IMGS_API_DOMAIN` – domain of the TradingView screenshot API.
- `TV_IMGS_API_KEY` – API key for the screenshot service.
- `TV_IMGS_LAYOUT_ID` – public TradingView layout identifier.
- `TV_IMGS_OUTPUT_DIR` – directory where chart images are saved.
- `TV_IMGS_THROTTLE` – optional requests per second limit (defaults to 9).

When used by the Obsidian deal tracker, chart images are requested only when a
new trade note is created. Screenshot downloads run asynchronously and are
rate‑limited to `TV_IMGS_THROTTLE` per second, so images may appear shortly
after notes are written.

### Order cards
- `ORDER_CARDS_PATH` – path to a file watched for order card definitions (when using the `file` source).
- `DEFAULT_EQUITY_STOP_USD` – default dollar amount to pre‑fill the Risk $ field on equity cards.
- Pending cards display a round button with the retry count; clicking it stops further retries and returns the card to an editable state.

## Documentation

See [docs/](docs/README.md) for an overview of the codebase and additional documentation.
