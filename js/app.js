// Brained — a fly brain spiking, with each window of fires committed on chain.
//
// What is real here, stated plainly because it is the whole point:
//   * the point cloud is 139,662 actual soma positions from MaleCNS v1.0
//   * the simulation runs on the traced sugar -> MN9 feeding subcircuit,
//     3,536 real neurons and 10,739 real synaptic connections, signed by
//     measured neurotransmitter
//   * the LIF parameters are Shiu et al., Nature 2024
//   * each window's spikes are hashed and that hash goes on chain
//
// What is not: the full 25.8M-edge connectome is not loaded, because it is a
// gigabyte. Spikes propagate through the feeding circuit, not the whole brain.

import { loadConnectome } from "./connectome-source.js";
import { CloudRenderer, Raster, Tape } from "./render.js";
import { Simulation, runWindow, DEFAULT_PARAMS } from "./sim/lif.js";
import { commitWindow, canHash } from "./sim/commit.js";
import { CANONICAL } from "./sim/canonical.js";
import { loadManifest, verifyWindowOnChain } from "./chain.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");

/**
 * 25 ms at 0.1 ms per tick — the window the readouts pool over, and the window
 * a committed leaf covers. Taken from the shared canonical definition rather
 * than repeated here: a page that pools over a different number of ticks than
 * the committer is running a different simulation, and would produce leaves
 * that never match without ever looking wrong.
 */
const TICKS_PER_WINDOW = CANONICAL.ticksPerWindow;
// Steady-state conductance is drive/(1-synDecay) = 50x the per-tick value, and
// the threshold gap is 7 mV. 0.3 puts the GRNs comfortably above it without
// pinning them at their refractory ceiling.
// Sweeping this is the demonstration. Below ~1.0 the sweet neurons fire
// happily and MN9 stays shut; above it the proboscis extends. MN9 sits under
// near-exact push-pull balance in the real wiring (2,429 excitatory against
// 2,352 inhibitory onto MN9_L), so sugar tips a decision rather than
// triggering a reflex — and that falls out of the connectome, not out of
// anything tuned here.
let SUGAR_DRIVE = CANONICAL.sugarDrive;

const state = {
  running: true,
  windowsPerSecond: 20,
  session: 0,
  windowIndex: 0,
  committed: 0,
  receipts: [],
  windows: new Map(), // index -> Window, kept so VERIFY can replay
  // The window at which this run stopped being the committed one, or null
  // while it still is. Changing the sugar drive is the whole demonstration, but
  // it makes the local simulation a different experiment from that window on.
  divergedAt: null,
  manifest: null,
};

async function main() {
  $("mode").textContent = "LOADING";
  let data;
  try {
    data = await loadConnectome();
  } catch (err) {
    $("mode").textContent = "NO DATA";
    $("provenance").innerHTML =
      `<b>connectome not loaded</b> — ${err.message}. ` +
      `Run <code>python data/prep.py</code> and <code>python data/fetch_circuit.py</code>, ` +
      `then copy <code>somas.bin</code>, <code>somas.json</code> and <code>circuit.json</code> into <code>site/data/</code>.`;
    throw err;
  }

  const { cloud, sim: connectome, cloudIndex, sugar, mn9, motor, counts } = data;

  $("dataset").textContent = data.label;
  $("mode").textContent = "LIVE";
  $("mode").classList.add("live");
  $("somas").textContent = fmt(counts.somas);
  $("provenance").innerHTML =
    `<b>${counts.somas.toLocaleString()} real somas</b> drawn from ${data.source}. ` +
    `Spikes are simulated on the traced sugar&nbsp;&rarr;&nbsp;MN9 feeding circuit — ` +
    `${fmt(counts.simNeurons)} neurons, ${fmt(counts.simEdges)} real connections ` +
    `(${fmt(counts.inhibitory)} inhibitory). The full connectome is ~25.8M edges and is not loaded, ` +
    `so activity spreads through the feeding pathway, not the whole brain. ` +
    `LIF parameters from Shiu et&nbsp;al., Nature 2024.`;

  // Renderer draws the whole cloud; the simulation only knows the subcircuit,
  // so spikes are mapped back onto cloud indices before drawing.
  const sugarCloud = new Set([...sugar].map((i) => cloudIndex[i]).filter((i) => i >= 0));
  const mn9Cloud = new Set([...mn9].map((i) => cloudIndex[i]).filter((i) => i >= 0));
  const cloudRenderer = new CloudRenderer($("cloud"), cloud, { sugar: sugarCloud, mn9: mn9Cloud });
  const raster = new Raster($("raster"), 12);
  const tape = new Tape($("tape"));

  const sim = new Simulation(connectome);
  sim.setDrive(sugar, SUGAR_DRIVE);

  // Motor pools for the body readout, by the type names the dataset uses.
  const mn9List = [...mn9];
  const motorList = [...motor];
  const pools = [
    ["proboscis / MN9", mn9List],
    ["proboscis motor pool", motorList],
    ["sweet GRN input", [...sugar]],
  ];
  const poolSets = new Map(pools.map(([name, list]) => [name, new Set(list)]));
  renderRates(pools, new Map());

  let lastFrame = performance.now();
  let acc = 0;
  let mn9Onset = null;

  function tickWindow() {
    const w = runWindow(sim, state.windowIndex, TICKS_PER_WINDOW);
    state.windows.set(w.index, w);
    // Keep memory bounded; VERIFY only ever needs what is on screen.
    if (state.windows.size > 400) {
      state.windows.delete(state.windows.keys().next().value);
    }

    // Feed the visuals from the window's spikes.
    const perPool = new Map();
    let mn9Spikes = 0;
    for (const tickSpikes of w.spikesByTick) {
      const cloudSpikes = [];
      const rasterRows = [];
      for (const id of tickSpikes) {
        const ci = cloudIndex[id];
        if (ci >= 0) cloudSpikes.push(ci);
        if (mn9.has(id)) {
          mn9Spikes++;
          rasterRows.push(mn9List.indexOf(id) % 12);
        } else if (motor.has(id)) {
          rasterRows.push(6 + (motorList.indexOf(id) % 6));
        }
      }
      cloudRenderer.update(Uint32Array.from(cloudSpikes));
      raster.push(rasterRows);
    }
    tape.push(w.count);

    // Set membership, not Array.includes: this runs per spike per tick and
    // the motor pool alone is 67 entries.
    for (const [name, list] of pools) {
      const set = poolSets.get(name);
      let n = 0;
      for (const tickSpikes of w.spikesByTick) for (const id of tickSpikes) if (set.has(id)) n++;
      perPool.set(name, n);
    }

    // Hz over the 25 ms window, both MN9 cells pooled
    const windowMs = TICKS_PER_WINDOW * DEFAULT_PARAMS.msPerTick;
    const hz = (mn9Spikes / Math.max(1, mn9List.length)) * (1000 / windowMs);
    $("mn9-hz").textContent = hz.toFixed(1);
    $("gate").textContent = hz > 0 ? "PROBOSCIS EXTENDED" : "proboscis shut";
    $("gate").style.color = hz > 0 ? "var(--red)" : "var(--muted)";
    if (mn9Spikes > 0 && mn9Onset === null) {
      mn9Onset = (sim.tick * DEFAULT_PARAMS.msPerTick).toFixed(1) + " ms";
      $("mn9-onset").textContent = mn9Onset;
    }

    renderRates(pools, perPool, windowMs);
    commitIfEnabled(w);
    state.windowIndex++;
  }

  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (state.running) {
      acc += dt;
      const interval = 1000 / state.windowsPerSecond;
      let budget = 4; // cap catch-up so a background tab does not stall on resume
      while (acc >= interval && budget-- > 0) {
        acc -= interval;
        tickWindow();
      }
    }
    cloudRenderer.update(new Uint32Array(0)); // decay trails
    cloudRenderer.draw();
    raster.draw();
    tape.draw();

    // Heat is the fraction of the SIMULATED circuit that is lit. Dividing by
    // all 139,662 somas would read ~1% no matter what, since only the feeding
    // circuit is ever active.
    const heat = Math.min(1, sim.activeCount() / counts.simNeurons);
    $("heat").textContent = (heat * 100).toFixed(0) + "%";
    $("heat-bar").style.width = Math.min(100, heat * 400).toFixed(1) + "%";
    $("spikes").textContent = fmt(sim.totalSpikes);
    $("active").textContent = fmt(sim.activeCount());
    $("window").textContent = `S${state.session} W${state.windowIndex}`;
    $("elapsed").textContent = (sim.tick * DEFAULT_PARAMS.msPerTick).toFixed(1);
    $("tel-ms").textContent = (sim.tick * DEFAULT_PARAMS.msPerTick).toFixed(1);
    $("tel-rate").textContent = state.windowsPerSecond.toFixed(1);
    $("tel-tx").textContent = `${fmt(state.committed)} / ${fmt(state.windowIndex)}`;
    $("tel-time").textContent = `S${state.session} · T${sim.tick}`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- controls ----
  $("pause").addEventListener("click", () => {
    state.running = !state.running;
    $("pause").textContent = state.running ? "PAUSE" : "RESUME";
    $("mode").textContent = state.running ? "LIVE" : "PAUSED";
  });
  $("reset").addEventListener("click", () => {
    sim.reset();
    sim.setDrive(sugar, SUGAR_DRIVE);
    // A reset at the canonical drive is not a new experiment, it is the same
    // run from the top — so it can be checked against the chain again.
    state.divergedAt = SUGAR_DRIVE === CANONICAL.sugarDrive ? null : 0;
    state.session++;
    state.windowIndex = 0;
    state.committed = 0;
    state.receipts = [];
    state.windows.clear();
    mn9Onset = null;
    $("mn9-onset").textContent = "—";
    $("receipts").innerHTML = "";
    $("landed").textContent = "0";
  });
  for (const b of document.querySelectorAll(".sugar-btn")) {
    b.addEventListener("click", () => {
      SUGAR_DRIVE = Number(b.dataset.drive);
      sim.clearDrive();
      if (SUGAR_DRIVE > 0) sim.setDrive(sugar, SUGAR_DRIVE);
      // Once the drive has been touched, this run is no longer the one on
      // chain — and it does not become it again by setting the drive back,
      // because the membrane state it passed through in between is different.
      // Record where it forked instead of pretending it did not.
      if (state.divergedAt === null && SUGAR_DRIVE !== CANONICAL.sugarDrive) {
        state.divergedAt = state.windowIndex;
        markDivergence();
      }
      mn9Onset = null;
      $("mn9-onset").textContent = "—";
      for (const o of document.querySelectorAll(".sugar-btn")) o.setAttribute("aria-pressed", String(o === b));
    });
  }
  for (const b of document.querySelectorAll(".rate-btn")) {
    b.addEventListener("click", () => {
      state.windowsPerSecond = Number(b.dataset.rate);
      for (const o of document.querySelectorAll(".rate-btn")) o.setAttribute("aria-pressed", String(o === b));
    });
  }

  await setupChain();
  setupLifeSupport(() => state.windowsPerSecond);
  $("verify").addEventListener("click", () => verifyAll(state));
}

function renderRates(pools, counts, windowMs = 25) {
  const el = $("rates");
  el.innerHTML = "";
  for (const [name, list] of pools) {
    const n = counts.get(name) ?? 0;
    const hz = list.length ? (n / list.length) * (1000 / windowMs) : 0;
    const row = document.createElement("div");
    row.className = "rate" + (hz > 0 ? " hot" : "");
    // The cell count and the rate must not run together: "· 2" next to
    // "0.0 Hz" reads as "20.0 Hz", which is a readout that lies.
    row.innerHTML =
      `<span class="n">${name}<span style="opacity:.5">&nbsp;&nbsp;×${list.length}</span></span>` +
      `<span class="hz">${hz.toFixed(1)} Hz</span>`;
    el.appendChild(row);
  }
}

// ---- chain ----------------------------------------------------------------

let chain = null;

async function setupChain() {
  let cfg = null;
  try {
    cfg = await (await fetch("./data/chain.json", { cache: "no-store" })).json();
  } catch {
    $("net").textContent = "not configured";
    $("verify-hint").textContent =
      "No chain configured yet. Windows are hashed locally; once a committer is pointed at this session its receipts appear here.";
    return;
  }

  // `configured` is the honest flag: the file existing does not mean a
  // committer is running against this deployment.
  chain = cfg.configured ? cfg : null;
  if (!cfg.configured) {
    $("net").textContent = "no committer";
    $("verify-hint").textContent =
      "No committer is running against this deployment yet, so nothing here is on chain. " +
      "Windows are hashed in the browser and VERIFY recomputes them locally — which proves " +
      "the hashing is deterministic, not that anything was published.";
    return;
  }

  state.manifest = await loadManifest();
  $("net").textContent = cfg.cluster ?? "devnet";

  if (!state.manifest) {
    $("verify-hint").textContent =
      `A ${cfg.cluster ?? "devnet"} committer is configured but has published no manifest yet, ` +
      "so there is nothing to check these windows against.";
    return;
  }

  const m = state.manifest;
  const last = m.receipts[m.receipts.length - 1].window;
  $("verify-hint").textContent =
    `${fmt(m.receipts.length)} window${m.receipts.length === 1 ? "" : "s"} of this run are on ${m.cluster} ` +
    `(S${m.session}, W0–W${last}). This page replays the same run; VERIFY recomputes each leaf here and ` +
    "fetches the memo from chain to compare. They were produced by different code on different machines.";
}

/** The run has forked from the committed one; say so where it is visible. */
function markDivergence() {
  if (!state.manifest) return;
  $("verify-hint").textContent =
    `This run left the committed one at W${state.divergedAt} — changing the sugar drive makes it a ` +
    "different simulation, so its leaves stop matching from there. Windows before that point still " +
    "check out; RESET at sweet returns to the committed run.";
}

/** The committed entry for a window, or null if this run is not that run. */
function committedEntry(index) {
  if (!state.manifest) return null;
  if (state.divergedAt !== null && index >= state.divergedAt) return null;
  return state.manifest.byWindow.get(index) ?? null;
}

let hashingWarned = false;

async function commitIfEnabled(w) {
  // The browser never holds a key. Committing is done by the committer process;
  // this page hashes the window so it can check what the committer published.
  //
  // Hashing needs a secure context. Over plain http there is nothing to do but
  // say so once — not throw on every window for as long as the page is open.
  if (!canHash()) {
    if (!hashingWarned) {
      hashingWarned = true;
      $("verify-hint").textContent =
        "Window hashing is unavailable over plain http — crypto.subtle only exists in a secure " +
        "context. The simulation is unaffected; receipts resume once this is served over https.";
      $("net").textContent = "needs https";
    }
    return;
  }
  const leaf = await commitWindow(w);
  const entry = committedEntry(w.index);
  if (entry) state.committed++;
  state.receipts.unshift({
    index: w.index,
    leaf: leaf.leaf,
    count: w.count,
    // A slot is only filled in from something that actually landed. An
    // optimistic slot here would make an uncommitted window look published.
    slot: entry ? entry.slot : null,
    signature: entry ? entry.signature : null,
    status: entry ? "onchain" : "local",
  });
  if (state.receipts.length > 60) state.receipts.pop();
  renderReceipts();
}

function explorerUrl(signature) {
  const t = state.manifest?.explorer ?? chain?.explorer;
  return t ? t.replace("{signature}", signature) : null;
}

function renderReceipts() {
  const el = $("receipts");
  el.innerHTML = "";
  const session = state.manifest && state.divergedAt === null ? state.manifest.session : state.session;
  for (const r of state.receipts.slice(0, 40)) {
    const row = document.createElement("div");
    row.className =
      "receipt" + (r.status === "verified" ? " verified" : r.status === "failed" ? " failed" : "");

    let meta;
    if (r.status === "verified") meta = `${r.count} spikes · verified slot ${fmt(r.slot)}`;
    else if (r.status === "failed") meta = `${r.count} spikes · ${r.reason ?? "verification failed"}`;
    else if (r.slot) meta = `${r.count} spikes · slot ${fmt(r.slot)}`;
    else meta = `${r.count} spikes · not yet committed`;

    const url = r.signature ? explorerUrl(r.signature) : null;
    row.innerHTML =
      `<span class="w">S${session} W${r.index}</span>` +
      `<span class="leaf">leaf ${r.leaf.slice(0, 12)}…</span>` +
      (url
        ? `<a class="meta" href="${url}" target="_blank" rel="noopener noreferrer">${meta}</a>`
        : `<span class="meta">${meta}</span>`);
    el.appendChild(row);
  }
  $("landed").textContent = fmt(state.receipts.length);
}

async function verifyAll() {
  if (!chain) {
    $("verify-hint").textContent = "Nothing to verify against — no chain is configured for this session.";
    return;
  }
  if (!state.manifest) {
    $("verify-hint").textContent = "No manifest is published, so there are no transactions to check against.";
    return;
  }
  $("verify").textContent = "VERIFYING…";

  const rpcUrl = state.manifest.rpcUrl ?? chain.rpcUrl;
  let ok = 0;
  let bad = 0;
  let local = 0;
  const failures = [];

  for (const r of state.receipts.slice(0, 20)) {
    const w = state.windows.get(r.index);
    if (!w) continue;
    // Recompute from the stored window rather than trusting the displayed leaf.
    const recomputed = await commitWindow(w);
    const entry = committedEntry(r.index);
    if (!entry) {
      // Nothing was published for this window. Saying "verified" here because
      // the local hash is self-consistent would be the exact dishonesty this
      // panel exists to avoid.
      r.status = "local";
      r.leaf = recomputed.leaf;
      local++;
      continue;
    }
    const res = await verifyWindowOnChain(rpcUrl, entry, recomputed.leaf, state.manifest.session);
    r.status = res.ok ? "verified" : "failed";
    r.slot = res.slot ?? entry.slot;
    r.signature = entry.signature;
    if (res.ok) ok++;
    else {
      bad++;
      r.reason = res.reason;
      if (failures.length < 2) failures.push(`W${r.index}: ${res.reason}`);
    }
  }

  renderReceipts();
  $("verify").textContent = "VERIFY ON CHAIN";

  if (!ok && !bad) {
    $("verify-hint").textContent =
      `None of the windows on screen are among the ${fmt(state.manifest.receipts.length)} that were committed ` +
      `— the page has run past W${state.manifest.receipts[state.manifest.receipts.length - 1].window}. RESET to replay from the start.`;
    return;
  }
  $("verify-hint").textContent =
    `${ok} window${ok === 1 ? "" : "s"} replayed here and matched the memo on ${state.manifest.cluster}` +
    `${bad ? `, ${bad} failed — ${failures.join("; ")}` : ""}` +
    `${local ? `. ${local} more on screen were never committed, so there is nothing to check them against` : ""}.`;
}

main().catch((e) => console.error(e));


// ---- life support ---------------------------------------------------------
//
// The framing is the honest one: every window is a transaction, transactions
// cost fees, and this wallet pays them. When it empties the commits stop. So
// the balance is not decoration — it is the thing that determines whether any
// of this keeps being recorded.

/** Base fee for a single-signature transaction. */
const LAMPORTS_PER_TX = 5000;
const LAMPORTS_PER_SOL = 1e9;

async function setupLifeSupport(currentRate) {
  const cfg = await fetch("./data/chain.json", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => null);
  const wallet = cfg?.wallet;
  if (!wallet) {
    $("wallet").textContent = "not configured";
    return;
  }

  $("wallet").textContent = wallet;
  $("ls-net").textContent = cfg.cluster ?? "solana";
  const explorer = (cfg.explorer ?? "").replace("/tx/{signature}", "/address/" + wallet);
  $("wallet-link").href = explorer || `https://explorer.solana.com/address/${wallet}`;

  $("copy-wallet").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      $("copy-wallet").textContent = "COPIED";
      setTimeout(() => ($("copy-wallet").textContent = "COPY"), 1400);
    } catch {
      // clipboard needs a secure context too; the address is on screen anyway
      $("copy-wallet").textContent = "SELECT IT";
      setTimeout(() => ($("copy-wallet").textContent = "COPY"), 1800);
    }
  });

  const perWindowSol = LAMPORTS_PER_TX / LAMPORTS_PER_SOL;
  $("per-window").textContent = perWindowSol.toFixed(6) + " SOL";

  // Check both networks. Reading only the configured one means that funding
  // the wallet on the other network shows a confident, wrong zero — and the
  // page would look broken for the one reason nobody would think to check.
  // api.mainnet-beta.solana.com returns 403 to browser requests; publicnode
  // serves the same data with CORS. Using the official endpoint here would
  // make every mainnet read fail, and the page would fall back to devnet's
  // zero and announce "not funded" for a wallet that is funded.
  const NETWORKS = [
    { name: "devnet", rpc: "https://api.devnet.solana.com", cluster: "?cluster=devnet" },
    { name: "mainnet", rpc: "https://solana-rpc.publicnode.com", cluster: "" },
  ];

  async function balanceOn(net) {
    const r = await fetch(net.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result?.value ?? 0;
  }

  async function poll() {
    const results = await Promise.all(
      NETWORKS.map((n) => balanceOn(n).then((v) => ({ net: n, lamports: v })).catch(() => null)),
    );
    const live = results.filter(Boolean);
    const unreadable = NETWORKS.filter((n) => !live.some((r) => r.net.name === n.name));
    if (!live.length) {
      // A public RPC will rate-limit. Say the reading is unavailable rather
      // than showing a stale number as if it were current.
      $("balance").textContent = "unavailable";
      $("remaining").textContent = "—";
      return;
    }
    // Whichever network actually holds something wins; otherwise the default.
    const funded = live.find((r) => r.lamports > 0);
    const chosen = funded ?? live.find((r) => r.net.name === (cfg.cluster ?? "devnet")) ?? live[0];
    const lamports = chosen.lamports;
    $("ls-net").textContent = chosen.net.name;
    $("wallet-link").href = `https://explorer.solana.com/address/${wallet}${chosen.net.cluster}`;

    const sol = lamports / LAMPORTS_PER_SOL;
    $("balance").textContent = sol.toFixed(6);
    $("balance").className = sol > 0 ? "alive" : "dying";

    const rate = currentRate();
    const burnPerHour = perWindowSol * rate * 3600;
    $("burn").textContent = burnPerHour.toFixed(3) + " SOL / hr";

    if (sol <= 0) {
      $("remaining").textContent = "not funded";
      $("remaining").className = "v dying";
      // Only claim "empty everywhere" if everywhere was actually readable.
      const caveat = unreadable.length
        ? ` Could not read ${unreadable.map((n) => n.name).join(" or ")}, so this balance covers ` +
          `${live.map((r) => r.net.name).join(" and ")} only.`
        : "";
      $("ls-hint").textContent =
        "This wallet is empty, so nothing is being committed. Every window of neuron fires " +
        "costs one transaction; fund it and the commits begin. The simulation runs either way — " +
        "what stops without funding is the record of it." + caveat;
      return;
    }
    const hours = sol / burnPerHour;
    $("remaining").className = "v alive";
    $("remaining").textContent =
      hours > 48 ? `${(hours / 24).toFixed(1)} days` : hours > 1 ? `${hours.toFixed(1)} hours` : `${(hours * 60).toFixed(0)} min`;
    $("ls-hint").textContent =
      `At ${rate} windows per second this burns ${burnPerHour.toFixed(3)} SOL an hour. ` +
      `When it empties, the commits stop.`;
  }

  await poll();
  // 30s: often enough to watch it drain, gentle enough for a public endpoint
  setInterval(poll, 30_000);
}
