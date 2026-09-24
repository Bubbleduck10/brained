// Turning a window of spikes into something a chain can attest to.
//
// A receipt is only worth anything if a third party can recompute it. So the
// encoding here is canonical — same spikes, same bytes, on any machine — and
// the leaf is a plain SHA-256 over those bytes. Anyone with the connectome, the
// seed and the window index can replay the simulation, rebuild the leaf, and
// check it against what was committed on chain. If the simulation were
// non-deterministic, or the encoding depended on object iteration order, the
// receipts would be unfalsifiable decoration.
/** Bumped if the encoding ever changes, so old receipts stay interpretable. */
export const COMMIT_VERSION = 1;
/**
 * Canonical bytes for a window.
 *
 *   u8   version
 *   u32  window index
 *   u32  start tick
 *   u32  tick count
 *   then per tick: u32 spike count, then that many u32 neuron ids, ASCENDING
 *
 * Little-endian throughout. Ascending ids matter: the same set of spikes must
 * produce the same bytes regardless of the order the simulation happened to
 * collect them in.
 */
export function encodeWindow(w) {
    let size = 1 + 4 + 4 + 4;
    for (const t of w.spikesByTick)
        size += 4 + t.length * 4;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint8(o, COMMIT_VERSION);
    o += 1;
    dv.setUint32(o, w.index, true);
    o += 4;
    dv.setUint32(o, w.startTick, true);
    o += 4;
    dv.setUint32(o, w.spikesByTick.length, true);
    o += 4;
    for (const tickSpikes of w.spikesByTick) {
        dv.setUint32(o, tickSpikes.length, true);
        o += 4;
        // copy before sorting: mutating the simulation's output in place would make
        // the encoder quietly destructive
        const ids = Uint32Array.from(tickSpikes).sort();
        for (const id of ids) {
            dv.setUint32(o, id, true);
            o += 4;
        }
    }
    return new Uint8Array(buf);
}
/** True when Web Crypto is actually available to hash with. */
export function canHash() {
    return typeof globalThis.crypto?.subtle?.digest === "function";
}
/**
 * SHA-256 via Web Crypto.
 *
 * `crypto.subtle` exists only in a SECURE CONTEXT — https, or localhost. Served
 * over plain http it is `undefined`, so this works in development and fails on
 * a freshly deployed domain whose certificate has not issued yet. Fail with a
 * sentence that says that, rather than "cannot read properties of undefined".
 */
export async function sha256(bytes) {
    if (!canHash()) {
        throw new Error("Web Crypto is unavailable: crypto.subtle only exists in a secure context (https or localhost). " +
            "Serve this over https and hashing will work.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function encodeBase58(bytes) {
    if (!bytes.length)
        return "";
    const digits = [0];
    for (const byte of bytes) {
        let carry = byte;
        for (let i = 0; i < digits.length; i++) {
            carry += digits[i] << 8;
            digits[i] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }
    let out = "";
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++)
        out += B58[0];
    for (let i = digits.length - 1; i >= 0; i--)
        out += B58[digits[i]];
    return out;
}
export async function commitWindow(w) {
    const bytes = encodeWindow(w);
    const hash = await sha256(bytes);
    return {
        index: w.index,
        startTick: w.startTick,
        count: w.count,
        hash,
        leaf: encodeBase58(hash),
        bytes,
    };
}
/**
 * Recompute a window's leaf and compare. This is what "VERIFY" does: it does
 * not trust the stored leaf, it rebuilds it from the spikes.
 */
export async function verifyWindow(w, expectedLeaf) {
    const { leaf } = await commitWindow(w);
    return leaf === expectedLeaf;
}
/**
 * Fold a run of leaves into a single root, so a long history can be attested
 * without committing every window separately.
 *
 * An odd node is carried up rather than duplicated. Duplicating the last leaf
 * is the classic Merkle malleability bug — it lets a different leaf set produce
 * the same root.
 */
export async function merkleRoot(leaves) {
    if (!leaves.length)
        return new Uint8Array(32);
    let level = leaves;
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            if (i + 1 === level.length) {
                next.push(level[i]); // carry, do not duplicate
                continue;
            }
            const pair = new Uint8Array(level[i].length + level[i + 1].length);
            pair.set(level[i], 0);
            pair.set(level[i + 1], level[i].length);
            next.push(await sha256(pair));
        }
        level = next;
    }
    return level[0];
}
