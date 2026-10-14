/* Compares what two photos look like: the same picture, the same picture
   flipped or rotated, or a different picture. Each photo is shrunk to a small
   grey grid (with its EXIF orientation applied, as Finder shows it) and the
   grids are compared in all 8 flips and rotations. */
(function (root) {
  "use strict";

  const N = 24;
  // Average difference per cell (0-255) below which two grids are the same picture.
  const MATCH = 14;
  // How each flip or rotation of the reference maps a target cell (x, y) to a reference cell.
  const OPS = [
    { id: "same", label: "same", swap: false, src: (x, y) => [x, y] },
    { id: "flipV", label: "flipped upside down", swap: false, src: (x, y) => [x, N - 1 - y] },
    { id: "flipH", label: "mirrored left to right", swap: false, src: (x, y) => [N - 1 - x, y] },
    { id: "rot180", label: "rotated 180°", swap: false, src: (x, y) => [N - 1 - x, N - 1 - y] },
    { id: "rot90", label: "rotated 90° clockwise", swap: true, src: (x, y) => [y, N - 1 - x] },
    { id: "rot270", label: "rotated 90° counter-clockwise", swap: true, src: (x, y) => [N - 1 - y, x] },
    { id: "transpose", label: "rotated and mirrored", swap: true, src: (x, y) => [y, x] },
    { id: "transverse", label: "rotated and mirrored", swap: true, src: (x, y) => [N - 1 - y, N - 1 - x] },
  ];

  function difference(ref, target, op) {
    let sum = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const [sx, sy] = op.src(x, y);
        sum += Math.abs(target[y * N + x] - ref[sy * N + sx]);
      }
    }
    return sum / (N * N);
  }

  const near = (a, b) => Math.abs(a - b) / Math.max(a, b) < 0.03;

  /**
   * { status: "same" | "transformed" | "different", label, op } for two
   * signatures ({ grid, width, height }).
   */
  function compare(ref, target) {
    const refAspect = ref.width / ref.height;
    const aspect = target.width / target.height;
    let best = null;
    for (const op of OPS) {
      if (!near(op.swap ? 1 / refAspect : refAspect, aspect)) continue;
      const d = difference(ref.grid, target.grid, op);
      if (op.id === "same" && d < MATCH) return { status: "same", label: "Same picture", op: "same", diff: d };
      if (!best || d < best.d) best = { op, d };
    }
    if (best && best.op.id !== "same" && best.d < MATCH) {
      const label = best.op.label[0].toUpperCase() + best.op.label.slice(1);
      return { status: "transformed", label, op: best.op.id, diff: best.d };
    }
    return { status: "different", label: "Different picture", op: null, diff: best ? best.d : null };
  }

  /** Grey grid of a grid of RGBA pixels (N x N). */
  function gridFromRgba(data) {
    const grid = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) grid[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    return grid;
  }

  /** Signature of a photo on disk, or null if it can't be decoded. Browser only. */
  async function signature(file) {
    const MF = root.MF;
    const res = await MF.api.run("exif.pictureData", { path: file }).catch(() => null);
    if (!res) return null;
    try {
      const text = atob(res.base64);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      const blob = new Blob([bytes]);
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
      const canvas = document.createElement("canvas");
      canvas.width = N;
      canvas.height = N;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, N, N);
      const sig = { grid: gridFromRgba(g.getImageData(0, 0, N, N).data), width: bmp.width, height: bmp.height };
      bmp.close();
      return sig;
    } catch {
      return null;
    }
  }

  const api = { N, OPS, MATCH, compare, gridFromRgba, signature };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.MF) root.MF.picture = api;
})(typeof window !== "undefined" ? window : globalThis);
