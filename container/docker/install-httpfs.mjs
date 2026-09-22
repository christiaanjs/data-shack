// Runs at Docker build time (see ../Dockerfile) to pre-cache the httpfs
// extension into a fixed directory baked into the image. Without this, every
// container start (or restart on a flaky free-tier host) would need an
// outbound fetch to extensions.duckdb.org before it could run any query
// touching r2://, r2-s3compat://, or http-ds:// URIs.
import { DuckDBInstance } from "@duckdb/node-api";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node install-httpfs.mjs <extension-directory>");
  process.exit(1);
}

const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();
await conn.run(`SET extension_directory = '${dir.replace(/'/g, "''")}';`);
await conn.run("INSTALL httpfs;");
await conn.run("LOAD httpfs;");
conn.closeSync();
console.log(`httpfs extension cached under ${dir}`);
