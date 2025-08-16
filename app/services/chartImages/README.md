# Chart Image Composers

A chart image composer creates a screenshot for a given fully qualified symbol
(e.g. `NYSE:AAPL`) and stores it on disk. The `compose(symbol)` method returns
the file name of the generated image.

## TV composer

`TvChartImageComposer` posts a request to a screenshot service based on a
public TradingView layout. Configuration options:

- `apiDomain` – API domain for requests
- `apiKey` – API key to authorize requests
- `layoutId` – public layout identifier
- `outputDir` – directory where images are written
- `throttlePerSecond` – maximum number of requests per second (defaults to 9)

Environment variables can supply these values via `${ENV:VAR}` references in the
config.
