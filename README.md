# Order Execution Gateway

Electron application that executes trading orders received from various sources through pluggable adapters. Order cards remain in the interface after an order is placed and collapse to a header with a colored status dot that reflects the position lifecycle:

- **blue** – order placed, waiting for fill
- **yellow** – position opened
- **green/red** – position closed in profit/loss

A lightweight event bus emits `order:placed`, `position:opened`, `position:closed` and `order:cancelled` so other parts of the app can react to changes.

## Configuration

Default configuration files live in `app/config/`. To customize any of them, copy the file to a `config/` directory in the project root and adjust as needed. On startup the application deep‑merges local overrides onto the bundled defaults.

Example:

```bash
mkdir -p config
cp app/config/order-cards.json config/order-cards.json
```

Notable configuration files include:

- [`app/config/execution.json`](app/config/execution.json) – execution providers and adapter settings.
- [`app/config/order-cards.json`](app/config/order-cards.json) – sources for incoming order cards.
- [`app/config/trade-rules.json`](app/config/trade-rules.json) – validation rules applied before orders are sent.
- [`app/config/deal-trackers.json`](app/config/deal-trackers.json) – trackers invoked when positions close.
- [`app/config/tv-logs.json`](app/config/tv-logs.json) – directories containing TradingView CSV logs.
- [`app/config/mt5-logs.json`](app/config/mt5-logs.json) – directories containing MetaTrader reports.
- [`app/config/chart-images.json`](app/config/chart-images.json) – chart screenshot service settings.
- [`app/config/tick-sizes.json`](app/config/tick-sizes.json) – tick size overrides for points calculations.

## Services

- **Execution Adapters** – registry that builds and caches connectors to execution providers. [Details](docs/execution-adapters.md)
- **Order Cards** – loads cards from sources like webhooks or files. [Details](app/services/orderCards/README.md)
- **Trade Rules** – validates orders before execution. [Details](app/services/tradeRules/README.md)
- **Deal Trackers** – persist closed trades or forward them elsewhere. [Details](app/services/dealTrackers/README.md)
- **Chart Images** – queues chart screenshots for use in notes. [Details](app/services/chartImages/README.md)
- **TradingView Logs** – turns TradingView order logs into closed trade events. [Details](app/services/tvLogs/README.md)
- **MT5 Logs** – parses MetaTrader 5 reports for closed trades. [Details](app/services/mt5Logs/README.md)
- **Webhooks** – converts raw webhook payloads into order card rows. [Details](app/services/webhooks/README.md)
- **Command Line** – text interface for quick actions. [Details](docs/command-line.md)
- **Points** – converts price differences into point values using tick sizes. [Details](app/services/points/README.md)
- **Order Calculator** – shared stop-loss, take-profit and position sizing math. [Details](docs/order-calculator.md)
- **Event Bus** – broadcasts order lifecycle events. [Details](docs/events.md)

## Documentation

See [docs/](docs/README.md) for an overview of the codebase and additional documentation.
