# Personal Data Warehouse

A personal data integration platform built on Cloudflare that brings your data together for querying, analysis, and dashboarding — with a privacy-preserving twist: the compute engine runs in your own browser.

## Architecture Overview

The system is built on Cloudflare's stack (Workers, D1, R2, Durable Objects, Pages) with OAuth-based authentication. The novel piece is that SQL execution happens in a **browser-local DuckDB instance** rather than on the server. The server orchestrates; your browser computes.

## Core Components

### Browser Compute Engine

A lightweight Cloudflare Pages frontend hosts a DuckDB instance that opens a long-lived "session" and receives query requests from the server over WebSockets. The WebSocket connection is managed via Cloudflare Durable Objects, which provide the stateful routing needed to pair a server-side query request with the right browser session.

This design keeps query execution and intermediate data on the client side — credentials and raw data don't need to flow through a central compute server. Longer term, the compute engine could optionally run in a container, or be swapped for something like Presto or Athena for workloads too heavy for in-browser DuckDB.

### Data Source Proxy Layer

Cloudflare Workers handle credential storage and act as proxies between the browser DuckDB and the underlying data sources. Credentials are stored encrypted in D1, with the worker handling decryption at request time.

Initial supported data sources:
- **D1** — structured tables (e.g. transactions)
- **R2** — JSON and Parquet files
- **Google Sheets** — via OAuth

### ETL Workers

Dedicated workers extract data from external APIs into the warehouse. The first integration is the **Akahu** NZ banking API, which pulls transactions into a D1 database. An open design question: whether ETL should run entirely server-side in workers, be orchestrated by the browser compute engine, or offer both modes depending on the source.

### MCP Server

An MCP server exposes the warehouse to AI clients like Claude:
- **Data source access** is handled directly by workers (metadata, schemas, etc.)
- **SQL query execution** is proxied through to the browser compute engine — which means the user must have an active browser session for queries to run

### Dashboarding Platform

Dashboards are React/HTML artifacts with props bound to SQL queries. The intended workflow:

1. Inside Claude.ai, the user iterates on visualizations and calculations using inline artifacts and widgets, with live data.
2. Once happy, Claude submits the dashboard via an MCP tool.
3. The server validates the artifact for security risks before persisting it.
4. Rendered dashboards run only in the browser, where the same query-proxy model applies.

## Design Principles

- **Data stays close to the user** — the browser is the compute boundary, not the server.
- **Cloudflare-native** — Workers, D1, R2, Durable Objects, and Pages do all the heavy lifting.
- **AI-first authoring** — dashboards and analyses are built conversationally with Claude, then submitted as artifacts.
- **Encrypted at rest** — data source secrets are encrypted in D1; only workers can decrypt them at use time.

## Open Questions

- ETL execution boundary (workers vs. browser vs. both)
- When/whether to add a server-side compute fallback for heavier workloads
- The exact validation model for user-submitted dashboard artifacts
