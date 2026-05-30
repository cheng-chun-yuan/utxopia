import { createSuiIndexerApi } from "./api";
import { InMemorySuiIndexerStore } from "./storage";

const packageId = process.env.UTXOPIA_SUI_PACKAGE_ID;
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

if (!packageId) {
  throw new Error("UTXOPIA_SUI_PACKAGE_ID is required");
}

const store = new InMemorySuiIndexerStore();
const fetch = createSuiIndexerApi({ packageId }, store);

Bun.serve({
  port,
  fetch,
});

console.log(`UTXOpia Sui indexer API listening on http://127.0.0.1:${port}`);

