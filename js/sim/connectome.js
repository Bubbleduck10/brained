// The connectome, in the shape the simulation needs it.
//
// Held as flat typed arrays rather than objects: at ~140k neurons and millions
// of synapses, an array of objects would be both far larger in memory and much
// slower to walk. Edges are stored in CSR form (compressed sparse row) so the
// out-edges of a neuron are one contiguous slice — which is exactly the access
// pattern a spike propagation step has.
/** Neurotransmitter sign. The connectome predicts these per neuron. */
export const EXCITATORY = 1;
export const INHIBITORY = -1;
/**
 * Validates a connectome and reports what it contains.
 *
 * Worth being strict here: a CSR array that is subtly wrong — offsets not
 * monotonic, a target index past the end — does not crash, it silently
 * propagates spikes to the wrong neurons, and the result still looks like a
 * plausible firing pattern.
 */
export function describe(c) {
    const { n, pos, offsets, targets, weights } = c;
    if (pos.length !== n * 3)
        throw new Error(`pos has ${pos.length} entries, expected ${n * 3}`);
    if (offsets.length !== n + 1)
        throw new Error(`offsets has ${offsets.length} entries, expected ${n + 1}`);
    if (offsets[0] !== 0)
        throw new Error(`offsets must start at 0, got ${offsets[0]}`);
    const edges = offsets[n];
    if (targets.length !== edges)
        throw new Error(`targets has ${targets.length} entries, expected ${edges}`);
    if (weights.length !== edges)
        throw new Error(`weights has ${weights.length} entries, expected ${edges}`);
    let maxOut = 0;
    let sinks = 0;
    for (let i = 0; i < n; i++) {
        const a = offsets[i];
        const b = offsets[i + 1];
        if (b < a)
            throw new Error(`offsets not monotonic at neuron ${i}: ${a} then ${b}`);
        const deg = b - a;
        if (deg === 0)
            sinks++;
        if (deg > maxOut)
            maxOut = deg;
    }
    const hasIncoming = new Uint8Array(n);
    let exc = 0;
    let inh = 0;
    for (let e = 0; e < edges; e++) {
        const t = targets[e];
        if (t >= n)
            throw new Error(`edge ${e} targets neuron ${t}, which is out of range (n=${n})`);
        hasIncoming[t] = 1;
        if (weights[e] >= 0)
            exc++;
        else
            inh++;
    }
    let sources = 0;
    for (let i = 0; i < n; i++)
        if (!hasIncoming[i])
            sources++;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
            const v = pos[i * 3 + k];
            if (!Number.isFinite(v))
                throw new Error(`neuron ${i} has a non-finite coordinate`);
            if (v < min[k])
                min[k] = v;
            if (v > max[k])
                max[k] = v;
        }
    }
    return {
        neurons: n,
        edges,
        meanOutDegree: n ? edges / n : 0,
        maxOutDegree: maxOut,
        excitatoryEdges: exc,
        inhibitoryEdges: inh,
        sinks,
        sources,
        bounds: { min, max },
    };
}
/**
 * Builds a CSR connectome from an edge list.
 *
 * Edges may arrive in any order; this sorts them into place. Duplicate
 * (source, target) pairs are summed rather than kept separately, which is what
 * a synapse count means.
 */
export function fromEdges(n, pos, edges, label, region, regionNames) {
    const merged = new Map();
    for (const { from, to, weight } of edges) {
        if (from < 0 || from >= n)
            throw new Error(`edge source ${from} out of range`);
        if (to < 0 || to >= n)
            throw new Error(`edge target ${to} out of range`);
        const key = from * n + to;
        merged.set(key, (merged.get(key) ?? 0) + weight);
    }
    const counts = new Uint32Array(n);
    for (const key of merged.keys())
        counts[Math.floor(key / n)]++;
    const offsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++)
        offsets[i + 1] = offsets[i] + counts[i];
    const total = offsets[n];
    const targets = new Uint32Array(total);
    const weights = new Float32Array(total);
    const cursor = offsets.slice(0, n);
    for (const [key, weight] of merged) {
        const from = Math.floor(key / n);
        const to = key % n;
        const at = cursor[from]++;
        targets[at] = to;
        weights[at] = weight;
    }
    return { n, pos, offsets, targets, weights, region, regionNames, label };
}
