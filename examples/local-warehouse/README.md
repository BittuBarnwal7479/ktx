# Local Warehouse Example

This example is a standalone KTX project that can be copied to a temp directory
and used with the local CLI and stdio MCP server. It uses the `fake` ingest
adapter so it does not require a database or external app server.

Run the example from the repository root after building the CLI:

```bash
pnpm --filter @ktx/cli run build
EXAMPLE_DIR="$(mktemp -d)/local-warehouse"
cp -R examples/local-warehouse "$EXAMPLE_DIR"
node packages/cli/dist/bin.js knowledge list --project-dir "$EXAMPLE_DIR"
node packages/cli/dist/bin.js sl list --project-dir "$EXAMPLE_DIR" --connection-id warehouse
node packages/cli/dist/bin.js ingest run --project-dir "$EXAMPLE_DIR" --connection-id warehouse --adapter fake --source-dir "$EXAMPLE_DIR/source"
```

The copied project creates its own Git repository on first use. Keep commands
pointed at a copy when experimenting so the checked-in example fixture stays
unchanged.
