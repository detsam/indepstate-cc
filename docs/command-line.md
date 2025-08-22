# Command Line Service

The bottom of the application window includes a text input that accepts simple commands. The renderer forwards entered strings to the main process where `app/services/commandLine.js` resolves the command name and executes the corresponding handler.

Commands are case-insensitive and may define multiple names (aliases).

## Commands

### add (alias: a)

```
add {ticker} {price} {sl} {tp} {risk}
```

Creates a new order card with the given ticker, entry price and stop loss. `tp` and `risk` are optional.

`sl` and `tp` accept either raw point values or prices containing a decimal dot. Dotted values are converted to integer points using the shared `digitsFallbackPoints` helper.

