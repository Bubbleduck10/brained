// Reading the committed run back off Solana, from the browser.
//
// No web3.js: this is two JSON-RPC calls and a regex, which is all that
// fetching a memo actually requires. Shipping a wallet library to read public
// data would be several hundred kilobytes to do less than this file does.
//
// The manifest (data/receipts.json) is written by the committer and says which
// signature carries which window. It is convenient, and it is NOT trusted — a
// manifest is just a file on the same web server as the page, so anyone who
// could tamper with one could tamper with both. Verification therefore checks
// three things against each other:
//
//   1. the leaf the browser recomputes by replaying the simulation
//   2. the leaf the manifest claims
//   3. the leaf in the memo of the transaction on chain
//
// Agreement between 1 and 3 is the result that means anything. The manifest is
// only there to find the transaction.

/** Mirrors encodeReceipt in committer/src/receipt.ts. */
const RECEIPT_RE = /^brained\/(\d+) S(\d+) W(\d+) ([1-9A-HJ-NP-Za-km-z]+) (\d+)$/;

export function parseReceipt(memo) {
  const m = memo.trim().match(RECEIPT_RE);
  if (!m) return null;
  return {
    version: Number(m[1]),
    session: Number(m[2]),
    window: Number(m[3]),
    leaf: m[4],
    spikes: Number(m[5]),
  };
}

export async function loadManifest() {
  try {
    const r = await fetch("./data/receipts.json", { cache: "no-store" });
    if (!r.ok) return null;
    const m = await r.json();
    if (!Array.isArray(m?.receipts) || !m.receipts.length) return null;
    // Index by window so lookup during verification is not a linear scan of a
    // list that grows with every committed window.
    m.byWindow = new Map(m.receipts.map((x) => [x.window, x]));
    return m;
  } catch {
    return null;
  }
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Pull our receipt out of a transaction.
 *
 * The memo program logs its own content, so the log line carries the memo
 * verbatim and we never have to decode instruction data or guess at an
 * encoding. Every memo log is checked rather than the first — a transaction
 * may legitimately carry more than one, and taking index 0 would silently read
 * someone else's.
 */
export async function fetchOnChainReceipt(rpcUrl, signature) {
  const tx = await rpc(rpcUrl, "getTransaction", [
    signature,
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) return { error: "transaction not found on this cluster" };
  if (tx.meta?.err) return { error: `transaction failed on chain: ${JSON.stringify(tx.meta.err)}` };

  for (const line of tx.meta?.logMessages ?? []) {
    const m = line.match(/Program log: Memo \(len \d+\): "(.*)"$/);
    if (!m) continue;
    const parsed = parseReceipt(m[1]);
    if (parsed) return { receipt: parsed, slot: tx.slot, blockTime: tx.blockTime ?? null };
  }
  return { error: "no Brained receipt in that transaction", slot: tx.slot };
}

/**
 * Check one window every way there is.
 *
 * `localLeaf` must come from replaying the simulation, not from anything the
 * page is displaying — otherwise this only proves the page agrees with itself.
 */
export async function verifyWindowOnChain(rpcUrl, entry, localLeaf, session) {
  if (entry.leaf !== localLeaf) {
    return {
      ok: false,
      reason: `replay produced ${localLeaf.slice(0, 12)}…, manifest claims ${entry.leaf.slice(0, 12)}…`,
    };
  }
  let res;
  try {
    res = await fetchOnChainReceipt(rpcUrl, entry.signature);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (res.error) return { ok: false, reason: res.error, slot: res.slot };

  const chain = res.receipt;
  if (chain.window !== entry.window || chain.session !== session) {
    return {
      ok: false,
      reason: `chain holds S${chain.session} W${chain.window}, expected S${session} W${entry.window}`,
      slot: res.slot,
    };
  }
  if (chain.leaf !== localLeaf) {
    return {
      ok: false,
      reason: `leaf mismatch: chain has ${chain.leaf.slice(0, 12)}…, replay produced ${localLeaf.slice(0, 12)}…`,
      slot: res.slot,
    };
  }
  return { ok: true, slot: res.slot, blockTime: res.blockTime };
}
