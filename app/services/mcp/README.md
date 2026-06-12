# MCP Service

This service exposes a local MCP endpoint for read-only data access from the running ISCC panel.

## Intentional Scope

- This MCP server is intended to be a data source by design.
- The initial tool, `get_deals_history`, reads closed deal history from a brokerage provider.
- It must not expose order placement, cancellation, position management, command execution, or generic brokerage passthrough tools.
- If execution over MCP is ever needed, build a separate MCP server for that purpose with its own explicit risk model, authentication, review, and operational safeguards.

Keeping data access and trade execution in separate MCP surfaces reduces the chance that a data-query client can accidentally or indirectly create live orders.
