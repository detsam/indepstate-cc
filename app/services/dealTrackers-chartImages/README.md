# Deal Trackers: Chart Images

A chart image composer creates a screenshot for a given fully qualified symbol
(e.g. `NYSE:AAPL`) and stores it on disk. The low level
`compose(symbol, layout)` method queues a request and immediately returns the
file name that will be written once the image downloads. The name includes the
layout identifier to avoid collisions when capturing multiple layouts
simultaneously. A default composer can be configured via
`app/services/dealTrackers-chartImages/config/chart-images.json` which also provides helper functions
`compose1D(symbol)` and `compose5M(symbol)` using the configured `layout1D` and
`layout5M` values.

## TV composer

`TvChartImageComposer` posts requests to a screenshot service based on a
TradingView layout. Requests start in the background and the composer ensures
no more than `throttlePerSecond` are launched per second. Configuration options:

- `apiDomain` – API domain for requests
- `apiKey` – API key to authorize requests
- `outputDir` – directory where images are written
- `throttlePerSecond` – maximum number of requests started per second (defaults to 9)
- `fallbackExchanges` – optional list of exchange prefixes to try when a symbol without an exchange returns 422

Environment variables can supply these values via `${ENV:VAR}` references in the
config.

If a request responds with HTTP 422 (unknown instrument), the composer retries by
prefixing the symbol with each fallback exchange name in order until one succeeds.
