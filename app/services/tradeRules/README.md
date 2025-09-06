# Trade Rules Service

Applies validation rules to order cards before they are sent to execution adapters.

## Configuration

Rules live in `app/config/trade-rules.json`.
Copy the file to the `config` directory under the application's user data path and adjust to override defaults.
Each rule block has an `enabled` flag and rule‑specific options.

Built‑in rules include:

- `maxOrderPriceDeviation` – limits how far the order price may deviate from the quote.
- `minStopPoints` – enforces a minimum stop distance in points.
- `maxQty` – caps position size.
