// What run the chain is a record of.
//
// A leaf commits to the spikes of one window. Two machines only produce the
// same leaf if they ran the same simulation, so "the same simulation" has to be
// pinned down somewhere both the committer and the browser can read. That is
// this file.
//
// Everything here is deliberately boring and fixed. The moment a parameter
// becomes a runtime choice, the receipts stop meaning anything: window 12 of
// your run and window 12 of mine would be different events wearing the same
// name. If one of these values has to change, bump `CANONICAL_VERSION` and
// start a new session — do not quietly alter a running one.
import { DEFAULT_PARAMS, Simulation } from "./lif.js";
export const CANONICAL_VERSION = 1;
export const CANONICAL = {
    version: CANONICAL_VERSION,
    ticksPerWindow: 250,
    // 1.2 is the interesting value: it is above the push-pull balance onto MN9,
    // so the proboscis extends. Anything else is a different experiment.
    sugarDrive: 1.2,
    params: DEFAULT_PARAMS,
};
/**
 * Build the simulation the committed run is defined as.
 *
 * Both sides call this rather than constructing a Simulation themselves. A
 * `setDrive` that one side forgot is exactly the kind of difference that
 * produces a plausible-looking stream of leaves that never match.
 */
export function canonicalSimulation(connectome, sugar) {
    const sim = new Simulation(connectome, CANONICAL.params);
    sim.setDrive(sugar, CANONICAL.sugarDrive);
    return sim;
}
/**
 * Does a local run still correspond to what was committed?
 *
 * Changing the sugar drive mid-run is a legitimate thing to do on the page —
 * it is the demonstration — but it makes the local simulation a different one,
 * and its leaves will stop matching the chain from that window on. That is not
 * a bug to paper over: it should be reported as divergence, with the window it
 * started at, rather than as a failed verification.
 */
export function isCanonical(opts) {
    return (opts.ticksPerWindow === CANONICAL.ticksPerWindow &&
        // float equality is right here: these are copied from the same constant,
        // not computed. A near-miss means someone typed a new number.
        opts.sugarDrive === CANONICAL.sugarDrive);
}
