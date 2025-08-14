# Project Documentation

This directory contains high-level notes about the codebase.

## Overview
- `app/main.js` – Electron main process wiring adapters and relaying events to the renderer
- `app/renderer.js` – UI layer showing order cards and status indicators
- `app/services/events.js` – lightweight event bus for `order:placed`, `position:opened`, `position:closed` and `order:cancelled`
- `app/services/dealTrackers/*` – pluggable trackers invoked when a position closes (e.g., Obsidian notes)
- `app/config/deal-trackers.json` – local configuration for deal trackers
- `OBSIDIAN_INDEPSTATE_VAULT` and `OBSIDIAN_INDEPSTATE_DEALS_JOURNAL` – environment variables consumed by the Obsidian deal tracker
- `app/adapters/*` – execution adapters such as the DWX connector, each can provide `listOpenOrders()` and `listClosedPositions()`

More documents can be added here as the project evolves.
