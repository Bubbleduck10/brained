// Loading the real connectome.
//
// Two assets, both generated offline from MaleCNS v1.0 (HHMI Janelia FlyEM,
// CC BY 4.0):
//
//   somas.bin   139,662 real soma positions, uint16-quantised to the bounding
//               box, plus a superclass byte each. 0.93 MiB.
//   circuit.json  the traced sugar -> MN9 feeding subcircuit: 3,536 neurons and
//               10,739 real edges, signed by neurotransmitter.
//
// The split is deliberate and is the honest version of this. The full edge list
// is ~1 GB and 25.8M edges, which no page is going to load. So the POINT CLOUD
// is every real soma, and the SIMULATION runs on the traced circuit that
// actually drives proboscis extension. Every spike shown travelled a connection
// that exists in the fly. Nothing here is invented wiring.

import { fromEdges } from "./sim/connectome.js";

const SOMAS_BIN = "./data/somas.bin";
const SOMAS_META = "./data/somas.json";
const CIRCUIT = "./data/circuit.json";

async function getJSON(url) {
  const r = await fetch(url, { cache: "force-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Dequantise the packed soma cloud back to micrometres. */
function unpackSomas(buf, meta) {
  const n = meta.n;
  const xyz = new Uint16Array(buf, 0, n * 3);
  const superclass = new Uint8Array(buf, n * 6, n);
  // bodyIds start at a 4-byte boundary, so copy rather than view — an
  // unaligned Uint32Array view throws on some engines and works on others,
  // which is the worst kind of bug to ship.
  const bodyIds = new Uint32Array(buf.slice(n * 7, n * 11));

  const pos = new Float32Array(n * 3);
  const [ox, oy, oz] = meta.origin;
  const [sx, sy, sz] = meta.span;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (xyz[i * 3] / 65535) * sx + ox;
    pos[i * 3 + 1] = (xyz[i * 3 + 1] / 65535) * sy + oy;
    pos[i * 3 + 2] = (xyz[i * 3 + 2] / 65535) * sz + oz;
  }
  return { pos, superclass, bodyIds };
}

export async function loadConnectome() {
  const [meta, circuit, binRes] = await Promise.all([
    getJSON(SOMAS_META),
    getJSON(CIRCUIT),
    fetch(SOMAS_BIN, { cache: "force-cache" }),
  ]);
  if (!binRes.ok) throw new Error(`${SOMAS_BIN}: HTTP ${binRes.status}`);
  const buf = await binRes.arrayBuffer();

  const expected = meta.n * 11; // 3 x uint16 + 1 byte class + uint32 bodyId
  if (buf.byteLength !== expected) {
    throw new Error(`somas.bin is ${buf.byteLength} bytes, expected ${expected} for ${meta.n} neurons`);
  }

  const { pos, superclass, bodyIds } = unpackSomas(buf, meta);

  // The simulation runs on the subcircuit. Map its bodyIds to a dense index
  // space, and remember which of those have a soma so the renderer can light
  // the right points. Sweet gustatory neurons have no soma in the dataset —
  // their cell bodies are in the labellum, outside the imaged volume — so they
  // are simulated without being drawn. That is anatomy, not missing data.
  const order = circuit.nodes;
  const idxOf = new Map(order.map((b, i) => [b, i]));
  const simN = order.length;

  const simPos = new Float32Array(simN * 3);
  const somaIdxOf = new Map();
  for (let i = 0; i < bodyIds.length; i++) somaIdxOf.set(bodyIds[i], i);
  const cloudIndex = new Int32Array(simN).fill(-1);
  for (let i = 0; i < simN; i++) {
    const at = somaIdxOf.get(order[i]);
    if (at !== undefined) {
      cloudIndex[i] = at;
      simPos[i * 3] = pos[at * 3];
      simPos[i * 3 + 1] = pos[at * 3 + 1];
      simPos[i * 3 + 2] = pos[at * 3 + 2];
    }
  }

  const edges = circuit.edges
    .map((e) => ({ from: idxOf.get(e.from), to: idxOf.get(e.to), weight: e.weight }))
    .filter((e) => e.from !== undefined && e.to !== undefined);

  const sim = fromEdges(simN, simPos, edges, meta.label);

  const toIdx = (ids) => new Set(ids.map((b) => idxOf.get(b)).filter((i) => i !== undefined));

  return {
    /** every real soma, for drawing */
    cloud: { n: meta.n, pos, superclass, bodyIds, superclasses: meta.superclasses },
    /** the traced circuit, for simulating */
    sim,
    cloudIndex,
    sugar: toIdx(circuit.sugar),
    mn9: toIdx(circuit.mn9),
    motor: toIdx(circuit.proboscisMotor),
    types: circuit.types ?? {},
    label: meta.label,
    source: meta.source,
    citation: meta.citation,
    counts: {
      somas: meta.n,
      simNeurons: simN,
      simEdges: edges.length,
      inhibitory: edges.filter((e) => e.weight < 0).length,
    },
  };
}
