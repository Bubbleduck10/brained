// Leaky integrate-and-fire over the connectome.
//
// The model, deliberately the simple one: each neuron holds a membrane
// potential that decays toward rest, incoming spikes push it up or down by the
// synaptic weight, and crossing threshold emits a spike, resets the potential
// and starts a refractory period. This is the same family of model used to
// reproduce feeding and grooming behaviour from the fly connectome — the
// wiring does the work, not the neuron model.
//
// Determinism is a requirement, not a nicety. The whole point of committing
// spike windows on chain is that anyone can replay the simulation from the same
// seed and get the same spikes, then check them against what was committed. So:
// no Math.random, no Date.now, no floating-point reduction order that depends
// on iteration order of a Map. Same seed and same connectome means the same
// spike train, every time, on any machine.
/**
 * Parameters from Shiu et al., Nature 634:210-219 (2024), the published LIF
 * model of the fly connectome that reproduced feeding and grooming. Units are
 * millivolts and milliseconds, not normalised, so these can be checked against
 * the paper rather than taken on trust.
 *
 *   v_0/v_rst -52 mV   resting and reset   (Kakaria & de Bivort 2017)
 *   v_th      -45 mV   threshold
 *   t_mbr      20 ms   membrane time constant
 *   t_rfc     2.2 ms   refractory          (Lazar et al. 2021)
 *   w_syn   0.275 mV   per synapse         (their one free parameter)
 *
 * `w_syn` is what turns an integer synapse count from the connectome into a
 * voltage step, so it is the number that sets whether anything fires at all.
 */
export const DEFAULT_PARAMS = {
    vRest: -52,
    vThreshold: -45,
    vReset: -52,
    // dv/dt = (v_0 - v + g)/t_mbr, so a 0.1 ms tick closes 0.1/20 of the gap
    leak: 0.1 / 20,
    refractoryTicks: 22, // 2.2 ms at 0.1 ms per tick
    synapticGain: 0.275,
    // dg/dt = -g/tau with tau = 5 ms
    synDecay: 1 - 0.1 / 5,
    msPerTick: 0.1,
};
/** A deterministic PRNG — see the note on determinism above. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export class Simulation {
    c;
    params;
    /** membrane potential per neuron */
    v;
    /** ticks remaining in refractory, per neuron */
    refractory;
    /** synaptic conductance per neuron — what spikes actually land in */
    g;
    /** input accumulated for the NEXT tick */
    inbox;
    /** neurons driven externally each tick (e.g. sugar sensors), and by how much */
    drive = new Map();
    driveIdx = new Uint32Array(0);
    driveAmt = new Float32Array(0);
    tick = 0;
    totalSpikes = 0;
    constructor(c, params = DEFAULT_PARAMS) {
        this.c = c;
        this.params = params;
        this.v = new Float32Array(c.n).fill(params.vRest);
        this.refractory = new Uint8Array(c.n);
        this.g = new Float32Array(c.n);
        this.inbox = new Float32Array(c.n);
    }
    /**
     * Set a constant external current on a set of neurons — the sugar drive on
     * the sensory neurons, for instance.
     */
    setDrive(neurons, amount) {
        for (const i of neurons) {
            if (i < 0 || i >= this.c.n)
                throw new Error(`drive neuron ${i} out of range`);
            if (amount === 0)
                this.drive.delete(i);
            else
                this.drive.set(i, amount);
        }
        // Flatten to arrays, sorted, so stepping does not depend on Map iteration
        // order — that would make the run non-reproducible across engines.
        const idx = [...this.drive.keys()].sort((a, b) => a - b);
        this.driveIdx = Uint32Array.from(idx);
        this.driveAmt = Float32Array.from(idx.map((i) => this.drive.get(i)));
    }
    clearDrive() {
        this.drive.clear();
        this.driveIdx = new Uint32Array(0);
        this.driveAmt = new Float32Array(0);
    }
    /** Advance one tick and return who fired. */
    step() {
        const { c, params, v, g, refractory, inbox } = this;
        const { vRest, vThreshold, vReset, leak, refractoryTicks, synapticGain, synDecay } = params;
        // 1. last tick's synaptic input lands in the conductance, which decays
        for (let i = 0; i < c.n; i++) {
            g[i] = g[i] * synDecay + inbox[i];
            inbox[i] = 0;
        }
        // 2. external drive goes into the conductance too, not straight onto v
        for (let k = 0; k < this.driveIdx.length; k++) {
            g[this.driveIdx[k]] += this.driveAmt[k];
        }
        // 3. membrane chases (rest + conductance) over the membrane time constant
        const fired = [];
        for (let i = 0; i < c.n; i++) {
            if (refractory[i] > 0) {
                refractory[i]--;
                continue;
            }
            v[i] += (vRest - v[i] + g[i]) * leak;
            if (v[i] >= vThreshold) {
                v[i] = vReset;
                refractory[i] = refractoryTicks;
                fired.push(i);
            }
        }
        // 4. propagate — ascending order, so the float additions happen in a fixed
        //    sequence and the result is bit-identical on a replay
        for (const i of fired) {
            const end = c.offsets[i + 1];
            for (let e = c.offsets[i]; e < end; e++) {
                inbox[c.targets[e]] += c.weights[e] * synapticGain;
            }
        }
        this.tick++;
        this.totalSpikes += fired.length;
        return { spikes: Uint32Array.from(fired), tick: this.tick };
    }
    /** How many neurons are currently above rest — a cheap "activity" readout. */
    activeCount(epsilon = 1e-4) {
        let n = 0;
        for (let i = 0; i < this.v.length; i++)
            if (this.v[i] > this.params.vRest + epsilon)
                n++;
        return n;
    }
    reset() {
        this.v.fill(this.params.vRest);
        this.refractory.fill(0);
        this.g.fill(0);
        this.inbox.fill(0);
        this.tick = 0;
        this.totalSpikes = 0;
    }
}
export function runWindow(sim, index, ticks) {
    const startTick = sim.tick;
    const spikesByTick = [];
    let count = 0;
    for (let t = 0; t < ticks; t++) {
        const { spikes } = sim.step();
        spikesByTick.push(spikes);
        count += spikes.length;
    }
    return { index, startTick, ticks, spikesByTick, count };
}
