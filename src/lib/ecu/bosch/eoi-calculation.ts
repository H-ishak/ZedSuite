import { isBigEndianEcu } from "@/lib/ecu-endianness";
import { resolveMapCellLayout, resolveAxisSources } from "@/lib/map-cell-layout";
import { DetectedMapLite, MapEditLite } from "@/lib/power-estimation";

export interface EoiCellResult {
  rpm: number;
  iq: number;
  soi: number; // ° BTDC
  duration: number; // ° CA
  eoiAtdc: number; // ° ATDC
  eoiBtdc: number; // ° BTDC
  status: "safe" | "caution" | "danger" | "early";
  activeDurationDesc: string;
}

export interface EoiMatrixResult {
  rpmAxis: number[];
  iqAxis: number[];
  cells: EoiCellResult[][]; // [rpmIndex][iqIndex]
  maxEoiAtdc: number;
  maxEoiPoint: { rpm: number; iq: number; eoiAtdc: number } | null;
  stats: {
    safe: number;
    caution: number;
    danger: number;
    early: number;
    total: number;
  };
  soiMapName: string;
  codeblockId: number | null;
}

export interface EoiCodeblockOption {
  id: number | null;
  label: string;
}

export interface EoiMapOption {
  address: number;
  name: string;
  codeblockId: number | null;
}

export interface EoiOptions {
  codeblockId: number | null;
  soiMapAddress?: number;
  durationMode: "auto" | "manual";
  manualDurationIndex?: number; // 0..5
  unit: "atdc" | "btdc";
  applySoiLimiter?: boolean;
}

// ── Binary & Axis Decoding ──────────────────────────────────────────

function readU16(bytes: Uint8Array, addr: number, bigEndian: boolean): number {
  if (addr + 1 >= bytes.length) return 0;
  return bigEndian
    ? (bytes[addr] << 8) | bytes[addr + 1]
    : (bytes[addr + 1] << 8) | bytes[addr];
}

function toSigned16(v: number): number {
  return v >= 0x8000 ? v - 0x10000 : v;
}

function decodeCell(
  bytes: Uint8Array,
  addr: number,
  dataType: string,
  bigEndian: boolean
): number {
  const dt = dataType.toLowerCase();
  if (dt === "uint8") return bytes[addr] ?? 0;
  if (dt === "int8") {
    const v = bytes[addr] ?? 0;
    return v >= 0x80 ? v - 0x100 : v;
  }
  const raw = readU16(bytes, addr, bigEndian);
  return dt === "int16" ? toSigned16(raw) : raw;
}

function decodeAxis(
  bytes: Uint8Array,
  addr: number,
  count: number,
  factor: number,
  offset: number,
  bigEndian: boolean
): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(readU16(bytes, addr + i * 2, bigEndian) * factor + offset);
  }
  return out;
}

function applyCellEdits(
  values: number[][],
  edits: MapEditLite[],
  mapAddress: number
): number[][] {
  let out = values;
  let copied = false;
  for (const edit of edits) {
    if (edit.map_address !== mapAddress) continue;
    const cells = edit.payload?.changedCells;
    if (!Array.isArray(cells)) continue;
    if (!copied) {
      out = values.map((r) => [...r]);
      copied = true;
    }
    for (const cell of cells) {
      if (
        typeof cell?.row === "number" &&
        typeof cell?.col === "number" &&
        typeof cell?.value === "number" &&
        out[cell.row] !== undefined &&
        out[cell.row][cell.col] !== undefined
      ) {
        out[cell.row][cell.col] = cell.value;
      }
    }
  }
  return out;
}

export interface Oriented2DMap {
  address: number;
  name: string;
  codeblockId: number | null;
  rpm: number[];
  iq: number[];
  v: number[][]; // [rpmIdx][iqIdx]
}

function orientMap(
  bytes: Uint8Array,
  map: DetectedMapLite,
  ecuType: string,
  edits: MapEditLite[]
): Oriented2DMap | null {
  const two = map.dimensions?.TwoDimensional;
  if (!two) return null;
  const cellSize = (map.data_type || "UInt16").toLowerCase().includes("8") ? 1 : 2;
  const mapInput = {
    ...map,
    rows_reversed: map.rows_reversed ?? undefined,
    size: two.rows * two.cols * cellSize,
  };
  const layout = resolveMapCellLayout(mapInput);
  const axes = resolveAxisSources(mapInput);
  if (!axes.x.address || !axes.y.address) return null;

  const bigEndian = isBigEndianEcu(ecuType);
  const cellBig = map.is_little_endian === true ? false : bigEndian;
  const dt = map.data_type || "UInt16";
  const factor = map.correction_factor ?? 1;
  const offset = map.offset ?? 0;

  // Read X axis (columns of displayed map)
  const x = decodeAxis(
    bytes,
    axes.x.address,
    layout.cols,
    axes.x.correction,
    axes.x.offset,
    bigEndian
  );

  // Read Y axis (rows of displayed map)
  const y = decodeAxis(
    bytes,
    axes.y.address,
    layout.rows,
    axes.y.correction,
    axes.y.offset,
    bigEndian
  );

  // Read display grid rows x cols exactly as MapViewer does
  let v: number[][] = [];
  for (let r = 0; r < layout.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < layout.cols; c++) {
      const fileIndex = layout.cellIndex(r, c);
      const addr = map.address + fileIndex * layout.cellBytes;
      row.push(decodeCell(bytes, addr, dt, cellBig) * factor + offset);
    }
    v.push(row);
  }
  v = applyCellEdits(v, edits, map.address);

  const xMax = Math.max(...x);
  const yMax = Math.max(...y);

  let rpmAxis: number[];
  let iqAxis: number[];
  let orientedV: number[][]; // [rpmIndex][iqIndex]

  // Identify which axis is RPM (RPM reaches > 1000; IQ is typically 0..80)
  if (yMax > 1000 && yMax >= xMax) {
    rpmAxis = [...y];
    iqAxis = [...x];
    orientedV = v.map((row) => [...row]);
  } else if (xMax > 1000) {
    // Transpose so rows are RPM and cols are IQ
    rpmAxis = [...x];
    iqAxis = [...y];
    orientedV = x.map((_, c) => v.map((row) => row[c]));
  } else {
    rpmAxis = [...y];
    iqAxis = [...x];
    orientedV = v.map((row) => [...row]);
  }

  // Ensure RPM axis is sorted ascending for proper 2D interpolation and display
  if (rpmAxis.length > 1 && rpmAxis[0] > rpmAxis[rpmAxis.length - 1]) {
    rpmAxis.reverse();
    orientedV.reverse();
  }
  // Ensure IQ axis is sorted ascending
  if (iqAxis.length > 1 && iqAxis[0] > iqAxis[iqAxis.length - 1]) {
    iqAxis.reverse();
    orientedV = orientedV.map((row) => row.slice().reverse());
  }

  return {
    address: map.address,
    name: map.name || "",
    codeblockId: map.codeblock_id ?? null,
    rpm: rpmAxis,
    iq: iqAxis,
    v: orientedV,
  };
}

function interp1(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return ys[0] ?? 0;

  const isAscending = xs[xs.length - 1] >= xs[0];
  if (isAscending) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const span = xs[i] - xs[i - 1];
        if (Math.abs(span) < 1e-9) return ys[i];
        const t = (x - xs[i - 1]) / span;
        return ys[i - 1] + t * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1];
  } else {
    // Descending axis
    if (x >= xs[0]) return ys[0];
    if (x <= xs[xs.length - 1]) return ys[ys.length - 1];
    for (let i = 1; i < xs.length; i++) {
      if (x >= xs[i]) {
        const span = xs[i] - xs[i - 1];
        if (Math.abs(span) < 1e-9) return ys[i];
        const t = (x - xs[i - 1]) / span;
        return ys[i - 1] + t * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1];
  }
}

function lookup2D(map: Oriented2DMap, rpm: number, iq: number): number {
  const col = map.iq.map((_, j) =>
    interp1(map.rpm, map.v.map((r) => r[j] ?? 0), rpm)
  );
  return interp1(map.iq, col, iq);
}

// ── Duration Selector Extraction ────────────────────────────────────

export interface DurationSelectorData {
  address: number;
  codeblockId: number | null;
  thresholds: number[]; // SOI advance values in ° BTDC
}

function readDurationSelector(
  bytes: Uint8Array,
  map: DetectedMapLite,
  ecuType: string
): DurationSelectorData | null {
  const addr = map.address;
  if (addr + 12 > bytes.length) return null;
  const bigEndian = isBigEndianEcu(ecuType);

  // Axis is at offset -16 (4 bytes header + 12 bytes axis data)
  // or via map.y_axis_address / map.x_axis_address
  let axisAddr = map.y_axis_address || map.x_axis_address;
  if (!axisAddr && addr >= 16) {
    axisAddr = addr - 12; // Axis data immediately preceding map data
  }

  const thresholds: number[] = [];
  const axisFactor = map.y_axis_correction ?? -0.023437;
  const axisOffset = map.y_axis_offset ?? 78.0;

  if (axisAddr && axisAddr + 12 <= bytes.length) {
    for (let i = 0; i < 6; i++) {
      const raw = readU16(bytes, axisAddr + i * 2, false); // EDC15 is little-endian
      thresholds.push(raw * axisFactor + axisOffset);
    }
  } else {
    // Fallback standard thresholds for 1.9 TDI PD if axis could not be read
    thresholds.push(25.0, 20.0, 15.0, 10.0, 5.0, 0.0);
  }

  return {
    address: addr,
    codeblockId: map.codeblock_id ?? null,
    thresholds,
  };
}

// ── Codeblocks and Map Discovery ────────────────────────────────────

export function getEoiCodeblocks(maps: DetectedMapLite[]): EoiCodeblockOption[] {
  const blockIds = new Set<number>();
  let hasNull = false;

  for (const m of maps) {
    const name = (m.name || "").toLowerCase();
    if (name.includes("start of injection") || name.includes("injector duration")) {
      if (m.codeblock_id !== null && m.codeblock_id !== undefined) {
        blockIds.add(m.codeblock_id);
      } else {
        hasNull = true;
      }
    }
  }

  const sortedIds = Array.from(blockIds).sort((a, b) => a - b);
  if (sortedIds.length === 0) {
    return [{ id: null, label: "Codeblock 1" }];
  }

  const options: EoiCodeblockOption[] = sortedIds.map((id, index) => ({
    id,
    label: `Codeblock ${index + 1} (ID: ${id})`,
  }));

  if (hasNull && options.length === 0) {
    options.push({ id: null, label: "Default" });
  }

  return options;
}

export function getAvailableSoiMaps(
  maps: DetectedMapLite[],
  codeblockId: number | null
): EoiMapOption[] {
  const isTargetBlock = (m: DetectedMapLite) =>
    codeblockId === null || m.codeblock_id === null || m.codeblock_id === undefined || m.codeblock_id === codeblockId;

  const result: EoiMapOption[] = [];
  for (const m of maps) {
    const name = m.name || "";
    const lower = name.toLowerCase();
    if (
      (lower.includes("start of injection") || lower.includes("soi")) &&
      !lower.includes("selector") &&
      !lower.includes("limiter") &&
      !lower.includes("limit") &&
      !lower.includes("bip") &&
      isTargetBlock(m)
    ) {
      result.push({
        address: m.address,
        name,
        codeblockId: m.codeblock_id ?? null,
      });
    }
  }

  // Sort: numbers 09 first (warm engine default), then descending or alphabetical
  result.sort((a, b) => {
    const aIs09 = a.name.includes("09");
    const bIs09 = b.name.includes("09");
    if (aIs09 && !bIs09) return -1;
    if (!aIs09 && bIs09) return 1;
    return a.name.localeCompare(b.name);
  });

  return result;
}

// ── EOI Calculation Engine ──────────────────────────────────────────

export function computeEoiMatrix(
  bytes: Uint8Array,
  maps: DetectedMapLite[],
  edits: MapEditLite[],
  ecuType: string,
  options: EoiOptions
): EoiMatrixResult | null {
  const { codeblockId, durationMode, manualDurationIndex = 0, applySoiLimiter = false } = options;

  const inBlock = (m: DetectedMapLite) =>
    codeblockId === null || m.codeblock_id === null || m.codeblock_id === undefined || m.codeblock_id === codeblockId;

  // 1. Locate SOI maps
  const soiMaps = maps.filter(
    (m) =>
      inBlock(m) &&
      (m.name || "").toLowerCase().includes("start of injection") &&
      !(m.name || "").toLowerCase().includes("selector") &&
      !(m.name || "").toLowerCase().includes("limiter") &&
      !(m.name || "").toLowerCase().includes("limit") &&
      !(m.name || "").toLowerCase().includes("bip")
  );

  if (soiMaps.length === 0) return null;

  // Select target SOI map: user specified address or default to 09 / first
  let targetSoiMapMeta = options.soiMapAddress
    ? soiMaps.find((m) => m.address === options.soiMapAddress)
    : soiMaps.find((m) => (m.name || "").includes("09")) || soiMaps[0];

  if (!targetSoiMapMeta) targetSoiMapMeta = soiMaps[0];

  const targetSoi = orientMap(bytes, targetSoiMapMeta, ecuType, edits);
  if (!targetSoi) return null;

  // Optional SOI Limiter
  let soiLimiter: Oriented2DMap | null = null;
  if (applySoiLimiter) {
    const limMeta = maps.find(
      (m) =>
        inBlock(m) &&
        ((m.name || "").toLowerCase().includes("start of injection limiter") ||
          (m.name || "").toLowerCase().includes("soi limiter"))
    );
    if (limMeta) {
      soiLimiter = orientMap(bytes, limMeta, ecuType, edits);
    }
  }

  // 2. Locate Duration maps (00 through 05)
  const durationMapMetas: (DetectedMapLite | null)[] = [null, null, null, null, null, null];
  for (const m of maps) {
    if (!inBlock(m)) continue;
    const lower = (m.name || "").toLowerCase();
    if (!lower.includes("duration") || lower.includes("selector")) continue;

    for (let i = 0; i <= 5; i++) {
      const idxStr = `0${i}`;
      if (lower.includes(idxStr) || lower.endsWith(` ${i}`)) {
        durationMapMetas[i] = m;
        break;
      }
    }
  }

  const durationMaps: (Oriented2DMap | null)[] = durationMapMetas.map((m) =>
    m ? orientMap(bytes, m, ecuType, edits) : null
  );

  // 3. Locate Duration Selector
  const selectorMeta = maps.find(
    (m) => inBlock(m) && (m.name || "").toLowerCase().includes("selector for injector duration")
  );
  const durationSelector = selectorMeta
    ? readDurationSelector(bytes, selectorMeta, ecuType)
    : null;

  // 4. Form grid and calculate EOI for each cell
  const rpmAxis = targetSoi.rpm;
  const iqAxis = targetSoi.iq;
  const cells: EoiCellResult[][] = [];

  let maxEoiAtdc = -Infinity;
  let maxEoiPoint: { rpm: number; iq: number; eoiAtdc: number } | null = null;
  const stats = { safe: 0, caution: 0, danger: 0, early: 0, total: 0 };

  for (let r = 0; r < rpmAxis.length; r++) {
    const rpm = rpmAxis[r];
    const rowResults: EoiCellResult[] = [];

    for (let c = 0; c < iqAxis.length; c++) {
      const iq = iqAxis[c];

      // Read SOI directly from the cell or interpolated
      let soi = targetSoi.v[r]?.[c] ?? lookup2D(targetSoi, rpm, iq);

      // Apply SOI limiter clamp if requested (clamped at 90°C coolant temp)
      if (soiLimiter) {
        const lim = lookup2D(soiLimiter, rpm, 90);
        if (soi > lim) soi = lim;
      }

      // Determine Duration
      let duration = 0;
      let activeDesc = "";

      if (durationMode === "manual") {
        const dIdx = Math.max(0, Math.min(5, manualDurationIndex));
        const dMap = durationMaps[dIdx] || durationMaps.find((m) => m !== null);
        if (dMap) {
          duration = lookup2D(dMap, rpm, iq);
          activeDesc = `Duration 0${dIdx}`;
        }
      } else {
        // Auto mode via Duration Selector
        // Standard Bosch EDC15: Duration 00 is for high advance (> 25°), Duration 05 is for low advance (<= 0°)
        // Sort thresholds descending: [27, 21, 15, 9, 4, 0]
        const rawTh = durationSelector?.thresholds && durationSelector.thresholds.length >= 2
          ? durationSelector.thresholds
          : [25, 20, 15, 10, 5, 0];
        const th = [...rawTh].sort((a, b) => b - a);

        if (soi >= th[0]) {
          const dMap = durationMaps[0] || durationMaps.find((m) => m !== null);
          duration = dMap ? lookup2D(dMap, rpm, iq) : 0;
          activeDesc = "Duration 00";
        } else if (soi <= th[th.length - 1]) {
          const lastIdx = Math.min(5, th.length - 1);
          const dMap = durationMaps[lastIdx] || durationMaps.find((m) => m !== null);
          duration = dMap ? lookup2D(dMap, rpm, iq) : 0;
          activeDesc = `Duration 0${lastIdx}`;
        } else {
          // Find bracket k where soi is between th[k] and th[k + 1]
          let bracket = 0;
          for (let k = 0; k < th.length - 1; k++) {
            if (soi <= th[k] && soi >= th[k + 1]) {
              bracket = k;
              break;
            }
          }

          const upperMap = durationMaps[bracket] || durationMaps.find((m) => m !== null);
          const lowerMap = durationMaps[bracket + 1] || durationMaps.find((m) => m !== null);

          const span = th[bracket] - th[bracket + 1];
          const factor = span > 0.001 ? (soi - th[bracket + 1]) / span : 0.5;

          const durUpper = upperMap ? lookup2D(upperMap, rpm, iq) : 0;
          const durLower = lowerMap ? lookup2D(lowerMap, rpm, iq) : durUpper;

          duration = factor * durUpper + (1 - factor) * durLower;
          activeDesc = `Dur 0${bracket} / 0${bracket + 1} (${Math.round(factor * 100)}%)`;
        }
      }

      // EOI Calculation:
      // EOI (° ATDC) = Duration - SOI
      // EOI (° BTDC) = SOI - Duration
      const eoiAtdc = duration - soi;
      const eoiBtdc = soi - duration;

      // Classify safety
      let status: "safe" | "caution" | "danger" | "early";
      if (eoiAtdc < 0) {
        status = "early";
        stats.early++;
      } else if (eoiAtdc <= 8.0) {
        status = "safe";
        stats.safe++;
      } else if (eoiAtdc <= 11.0) {
        status = "caution";
        stats.caution++;
      } else {
        status = "danger";
        stats.danger++;
      }
      stats.total++;

      if (eoiAtdc > maxEoiAtdc) {
        maxEoiAtdc = eoiAtdc;
        maxEoiPoint = { rpm, iq, eoiAtdc };
      }

      rowResults.push({
        rpm,
        iq,
        soi: Math.round(soi * 100) / 100,
        duration: Math.round(duration * 100) / 100,
        eoiAtdc: Math.round(eoiAtdc * 100) / 100,
        eoiBtdc: Math.round(eoiBtdc * 100) / 100,
        status,
        activeDurationDesc: activeDesc,
      });
    }

    cells.push(rowResults);
  }

  return {
    rpmAxis,
    iqAxis,
    cells,
    maxEoiAtdc: Math.round(maxEoiAtdc * 100) / 100,
    maxEoiPoint,
    stats,
    soiMapName: targetSoiMapMeta.name || "Start of injection",
    codeblockId,
  };
}
