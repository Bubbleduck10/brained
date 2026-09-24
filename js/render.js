// Point-cloud renderer for the nervous system.
//
// At ~140k somas, one fillRect per point is far too slow to hold a frame rate —
// the browser spends all its time in path setup. So positions are projected
// once at load, and each frame writes pixels straight into an ImageData buffer.
// That turns drawing into array writes, which stays comfortable at this count.

/** Packs to the 0xAABBGGRR word layout a little-endian Uint32Array view wants. */
function rgba(r, g, b, a = 255) {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function parseHex(hex) {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * The palette lives in the stylesheet, not here.
 *
 * The point cloud and the chrome around it have to agree — a canvas painted
 * with its own copy of the background is the kind of thing that only shows up
 * as a seam once the theme changes. So read the same custom properties the CSS
 * uses, and fall back to the amber values only if there is no document to read
 * (tests, workers).
 */
const FALLBACK = {
  "--bg": "#0a0705",
  "--panel": "#140f09",
  "--line": "#3a2c18",
  "--tissue": "#6b4a1e",
  "--amber": "#ffa629",
  "--hot": "#ff6b1a",
  "--red": "#e8384f",
  "--cream": "#ffd9a0",
};

function theme(name) {
  if (typeof getComputedStyle === "function" && typeof document !== "undefined") {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    if (v && v.trim()) return v.trim();
  }
  return FALLBACK[name];
}

const BG = parseHex(theme("--bg"));

/** Panel fill and gridlines for the two small canvases. */
export const CHROME = {
  panel: theme("--panel"),
  grid: (() => {
    const [r, g, b] = parseHex(theme("--line"));
    return `rgba(${r},${g},${b},0.6)`;
  })(),
  raster: theme("--red"),
  tape: theme("--amber"),
};

export const PALETTE = {
  resting: rgba(...parseHex(theme("--tissue"))),
  firing: rgba(...parseHex(theme("--hot"))),
  sugar: rgba(...parseHex(theme("--cream"))),
  mn9: rgba(...parseHex(theme("--red"))),
  glow: rgba(...parseHex(theme("--amber"))),
};

export class CloudRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{n:number,pos:Float32Array}} connectome
   * @param {{sugar?:Set<number>, mn9?:Set<number>}} marks
   */
  constructor(canvas, connectome, marks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.n = connectome.n;
    this.sugar = marks.sugar ?? new Set();
    this.mn9 = marks.mn9 ?? new Set();

    this.w = canvas.width;
    this.h = canvas.height;
    this.image = this.ctx.createImageData(this.w, this.h);
    this.pixels = new Uint32Array(this.image.data.buffer);

    // Per-neuron screen position, computed once.
    this.px = new Int32Array(this.n);
    this.py = new Int32Array(this.n);
    // Decaying brightness per neuron, so a spike leaves a trail rather than a
    // single-frame flash nobody can see.
    this.heat = new Float32Array(this.n);

    this.project(connectome.pos);
  }

  /**
   * Dorsal projection: looking down on the fly, anterior at the top. The
   * connectome's own axes are used directly, only scaled to fit, so the shape
   * on screen is the shape in the data rather than an artistic arrangement.
   */
  project(pos) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = 14;
    const sx = (this.w - pad * 2) / Math.max(1e-6, maxX - minX);
    const sy = (this.h - pad * 2) / Math.max(1e-6, maxY - minY);
    const s = Math.min(sx, sy);
    const ox = (this.w - (maxX - minX) * s) / 2;
    const oy = (this.h - (maxY - minY) * s) / 2;

    for (let i = 0; i < this.n; i++) {
      this.px[i] = Math.round((pos[i * 3] - minX) * s + ox);
      this.py[i] = Math.round((pos[i * 3 + 1] - minY) * s + oy);
    }
  }

  /** @param {Uint32Array} spikes neurons that fired this tick */
  update(spikes, decay = 0.88) {
    const heat = this.heat;
    for (let i = 0; i < heat.length; i++) heat[i] *= decay;
    for (const id of spikes) heat[id] = 1;
  }

  draw() {
    const { pixels, px, py, w, h, heat } = this;
    const base = rgba(BG[0], BG[1], BG[2]);
    pixels.fill(base);

    // Resting somas first, so anything firing draws over them.
    for (let i = 0; i < this.n; i++) {
      const x = px[i];
      const y = py[i];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const at = y * w + x;
      if (heat[i] > 0.02) continue;
      pixels[at] = PALETTE.resting;
    }

    for (let i = 0; i < this.n; i++) {
      const hv = heat[i];
      if (hv <= 0.02) continue;
      const x = px[i];
      const y = py[i];
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;

      const colour = this.mn9.has(i) ? PALETTE.mn9 : this.sugar.has(i) ? PALETTE.sugar : PALETTE.firing;
      const at = y * w + x;
      pixels[at] = colour;
      // A one-pixel soma is invisible at this density once it fires; a small
      // cross reads as a spike without needing a real blur pass.
      if (hv > 0.5) {
        pixels[at - 1] = colour;
        pixels[at + 1] = colour;
        pixels[at - w] = colour;
        pixels[at + w] = colour;
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Fraction of neurons currently lit — the "spike heat" readout. */
  heatFraction() {
    let n = 0;
    for (let i = 0; i < this.heat.length; i++) if (this.heat[i] > 0.02) n++;
    return n / this.heat.length;
  }
}

/** Rolling spike raster for a small set of tracked neurons. */
export class Raster {
  constructor(canvas, rows = 12) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.rows = rows;
    this.history = [];
    this.max = canvas.width;
  }
  push(activeRows) {
    this.history.push(activeRows);
    if (this.history.length > this.max) this.history.shift();
  }
  draw() {
    const { ctx, canvas, rows } = this;
    ctx.fillStyle = CHROME.panel;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const rowH = canvas.height / rows;

    ctx.strokeStyle = CHROME.grid;
    ctx.lineWidth = 1;
    for (let r = 1; r < rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * rowH);
      ctx.lineTo(canvas.width, r * rowH);
      ctx.stroke();
    }

    ctx.fillStyle = CHROME.raster;
    const x0 = canvas.width - this.history.length;
    for (let i = 0; i < this.history.length; i++) {
      for (const r of this.history[i]) {
        ctx.fillRect(x0 + i, r * rowH + 1, 1, Math.max(2, rowH - 2));
      }
    }
  }
}

/** The telemetry tape — spikes per tick, scrolling. */
export class Tape {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.values = [];
  }
  push(v) {
    this.values.push(v);
    if (this.values.length > this.canvas.width) this.values.shift();
  }
  draw() {
    const { ctx, canvas, values } = this;
    ctx.fillStyle = CHROME.panel;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!values.length) return;
    const peak = Math.max(1, ...values);
    ctx.fillStyle = CHROME.tape;
    const x0 = canvas.width - values.length;
    for (let i = 0; i < values.length; i++) {
      const hgt = (values[i] / peak) * (canvas.height - 4);
      ctx.fillRect(x0 + i, canvas.height - hgt, 1, hgt);
    }
  }
}
