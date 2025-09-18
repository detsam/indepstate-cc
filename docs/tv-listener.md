# tv-listener Service

The `tv-listener` service subscribes to TradingView traffic exposed by the `tv-proxy` service. It
parses horizontal line updates from `LineToolHorzLine` payloads, stores the latest activity and
exposes helpers that other services and commands can consume.

## Configuration

Configure the service via `app/services/tvListener/config/tv-listener.json`:

- `enabled` (boolean, default `true`) – disables the service when set to `false`.
- `webhook.enabled` (boolean, default `false`) – forwards selected TradingView messages to an HTTP
  endpoint when enabled.
- `webhook.port` (number) – port used to build the webhook URL when `webhook.url` is empty. The
  service posts to `http://localhost:{port}/webhook`.
- `webhook.url` (string) – explicit URL for webhook deliveries. Takes precedence over `port`.

The webhook integration forwards TradingView messages that contain `@ATR` in their text body using an
HTTP `POST` request with the raw message as the payload.

## Command Line Integration

`tv-listener` registers the `last` command, which reuses the most recent horizontal line event to
create a card. When TradingView provides a line identifier, the created card receives a
`producingLineId` property so later automation can correlate the card with the TradingView object
that produced it.

## Action Bus Integration

`tvListener` emits the `tv-tool-horzline` event whenever TradingView sends a horizontal line update.
The payload matches the last activity used by the `last` command: `{ symbol, price, lineId? }`. When
TradingView provides a persistent identifier, the payload includes `lineId` so downstream automation
can correlate follow-up events.

When TradingView deletes a horizontal line, `tvListener` emits `tv-tool-horzline-remove` with the
payload `{ lineId }`. Binding that event to `commandLine:rm producingLineId:{lineId}` removes the card
that originated from the deleted line, keeping the UI in sync with TradingView.
