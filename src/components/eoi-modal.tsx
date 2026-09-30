"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { FileRecord, Version } from "@/lib/types";
import * as localStore from "@/lib/local/store";
import { useI18n } from "@/contexts/i18n-context";
import { useThemeOptional } from "@/contexts/theme-context";
import {
  computeEoiMatrix,
  getEoiCodeblocks,
  getAvailableSoiMaps,
  EoiMatrixResult,
  EoiCellResult,
} from "@/lib/ecu/bosch/eoi-calculation";
import {
  Timer,
  AlertTriangle,
  CheckCircle2,
  Flame,
  Info,
  Layers,
  Sliders,
  RotateCcw,
  Sparkles,
} from "lucide-react";

export interface LiveEoiSource {
  versionId: string;
  getState: () => { bytes: Uint8Array; edits: Array<{ map_address: number; payload?: any }> };
  refreshKey: number;
}

interface EoiModalProps {
  file: FileRecord;
  onClose: () => void;
  live?: LiveEoiSource;
  embedded?: boolean;
  onMinWidthChange?: (px: number) => void;
  onContentHeightChange?: (px: number) => void;
  maps?: any[];
  liveBytes?: Uint8Array;
}

export function EoiModal({
  file,
  onClose,
  live,
  embedded = false,
  onMinWidthChange,
  onContentHeightChange,
  maps: mapsProp,
  liveBytes,
}: EoiModalProps) {
  const liveRef = useRef<LiveEoiSource | undefined>(live);
  liveRef.current = live;

  const { t } = useI18n();
  const themeCtx = useThemeOptional();
  const L = (themeCtx?.theme ?? "default") === "light";
  const oled = (themeCtx?.theme ?? "default") === "oled";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Parse maps from prop or file detection data
  const maps = useMemo(() => {
    if (mapsProp && mapsProp.length > 0) {
      return mapsProp;
    }
    try {
      const detection =
        typeof file.detection_data === "string"
          ? JSON.parse(file.detection_data)
          : file.detection_data;
      return detection?.maps || [];
    } catch {
      return [];
    }
  }, [mapsProp, file.detection_data]);

  // Codeblock options
  const codeblockOptions = useMemo(() => getEoiCodeblocks(maps), [maps]);
  const [selectedCodeblock, setSelectedCodeblock] = useState<number | null>(() => {
    return codeblockOptions[0]?.id ?? null;
  });

  // Available SOI maps for the selected codeblock
  const availableSoiMaps = useMemo(
    () => getAvailableSoiMaps(maps, selectedCodeblock),
    [maps, selectedCodeblock]
  );

  const [selectedSoiAddress, setSelectedSoiAddress] = useState<number | undefined>(() => {
    return availableSoiMaps[0]?.address;
  });

  // Synchronize selected SOI address when codeblock changes
  useEffect(() => {
    if (availableSoiMaps.length > 0) {
      const match = availableSoiMaps.find((m) => m.address === selectedSoiAddress);
      if (!match) {
        setSelectedSoiAddress(availableSoiMaps[0]?.address);
      }
    }
  }, [availableSoiMaps, selectedSoiAddress]);

  // Configuration options
  const [durationMode, setDurationMode] = useState<"auto" | "manual">("auto");
  const [manualDurationIndex, setManualDurationIndex] = useState<number>(0);
  const [unit, setUnit] = useState<"atdc" | "btdc">("atdc");
  const [applySoiLimiter, setApplySoiLimiter] = useState(false);

  // Calculation output
  const [matrixResult, setMatrixResult] = useState<EoiMatrixResult | null>(null);
  const [selectedCell, setSelectedCell] = useState<EoiCellResult | null>(null);

  // Size measurement for embedded FloatingWindow
  const contentRef = useRef<HTMLDivElement>(null);
  const lastContentHeightRef = useRef(0);

  useEffect(() => {
    if (!embedded || !onContentHeightChange) return;
    const el = contentRef.current;
    if (!el) return;
    const report = () => {
      const h = Math.ceil(el.getBoundingClientRect().height + 32);
      if (h === lastContentHeightRef.current) return;
      lastContentHeightRef.current = h;
      onContentHeightChange(h);
    };
    report();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [embedded, onContentHeightChange, matrixResult]);

  useEffect(() => {
    if (embedded && onMinWidthChange) {
      onMinWidthChange(760);
    }
  }, [embedded, onMinWidthChange]);

  // Compute EOI
  const calculate = async () => {
    setLoading(true);
    setError(null);
    try {
      let bytes: Uint8Array;
      let edits: Array<{ map_address: number; payload?: any }> = [];

      const currentLive = liveRef.current;
      if (liveBytes && liveBytes.length > 0) {
        bytes = liveBytes;
        if (currentLive) {
          edits = currentLive.getState().edits || [];
        }
      } else if (currentLive) {
        const state = currentLive.getState();
        bytes = state.bytes;
        edits = state.edits || [];
      } else {
        const binary = await localStore.readBinary(file.id);
        if (!binary) throw new Error("No binary data");
        bytes = new Uint8Array(binary);
      }

      const res = computeEoiMatrix(bytes, maps, edits, file.ecu_type || "", {
        codeblockId: selectedCodeblock,
        soiMapAddress: selectedSoiAddress,
        durationMode,
        manualDurationIndex,
        unit,
        applySoiLimiter,
      });

      if (!res) {
        setError("no_maps");
        setMatrixResult(null);
      } else {
        setMatrixResult(res);
        // Default selected cell to max EOI point or first cell
        if (res.maxEoiPoint) {
          const row = res.cells.find((r) => r.some((c) => c.rpm === res.maxEoiPoint?.rpm));
          const cell = row?.find((c) => c.iq === res.maxEoiPoint?.iq);
          setSelectedCell(cell || res.cells[0]?.[0] || null);
        } else {
          setSelectedCell(res.cells[0]?.[0] || null);
        }
      }
    } catch (err) {
      console.error("EOI calculation error:", err);
      setError("calc_error");
    } finally {
      setLoading(false);
    }
  };

  // Recompute when inputs or live refresh key changes
  useEffect(() => {
    void calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedCodeblock,
    selectedSoiAddress,
    durationMode,
    manualDurationIndex,
    unit,
    applySoiLimiter,
    live?.refreshKey,
    live?.versionId,
    liveBytes,
    maps,
  ]);

  // Color classes for cell statuses
  const getCellClasses = (status: EoiCellResult["status"], isSelected: boolean) => {
    let base = "text-center font-mono text-xs px-2 py-1.5 transition-all cursor-pointer select-none ";
    if (isSelected) {
      base += "ring-2 ring-blue-500 font-bold z-10 scale-105 shadow-md ";
    }

    if (L) {
      // Light theme
      switch (status) {
        case "safe":
          return base + "bg-emerald-100 hover:bg-emerald-200 text-emerald-900 border-emerald-300";
        case "caution":
          return base + "bg-amber-100 hover:bg-amber-200 text-amber-900 border-amber-300";
        case "danger":
          return base + "bg-rose-100 hover:bg-rose-200 text-rose-900 border-rose-300";
        case "early":
        default:
          return base + "bg-sky-100 hover:bg-sky-200 text-sky-900 border-sky-300";
      }
    } else {
      // Dark / OLED theme
      switch (status) {
        case "safe":
          return base + "bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border-emerald-800/40";
        case "caution":
          return base + "bg-amber-950/40 hover:bg-amber-900/60 text-amber-300 border-amber-800/40";
        case "danger":
          return base + "bg-rose-950/50 hover:bg-rose-900/70 text-rose-300 border-rose-800/50";
        case "early":
        default:
          return base + "bg-sky-950/30 hover:bg-sky-900/50 text-sky-300 border-sky-800/30";
      }
    }
  };

  const getStatusBadge = (status: EoiCellResult["status"]) => {
    switch (status) {
      case "safe":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" />
            {t.eoiModal.optimal}
          </span>
        );
      case "caution":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-3.5 h-3.5" />
            {t.eoiModal.caution}
          </span>
        );
      case "danger":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/40 animate-pulse">
            <Flame className="w-3.5 h-3.5" />
            {t.eoiModal.danger}
          </span>
        );
      case "early":
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-sky-500/15 text-sky-400 border border-sky-500/30">
            <Info className="w-3.5 h-3.5" />
            {t.eoiModal.early}
          </span>
        );
    }
  };

  return (
    <div
      ref={contentRef}
      className={`flex flex-col gap-4 p-4 text-sm ${
        L ? "text-slate-800" : "text-slate-100"
      }`}
    >
      {/* ── Top Controls Bar ────────────────────────────────────────── */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border backdrop-blur-md ${
          L
            ? "bg-slate-100/80 border-slate-200"
            : oled
            ? "bg-black border-neutral-800"
            : "bg-slate-900/70 border-slate-800"
        }`}
      >
        <div className="flex flex-wrap items-center gap-3">
          {/* Codeblock Selector */}
          {codeblockOptions.length > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium opacity-70 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" />
                {t.eoiModal.codeblock}:
              </span>
              <select
                aria-label={t.eoiModal.codeblock}
                value={selectedCodeblock ?? ""}
                onChange={(e) =>
                  setSelectedCodeblock(e.target.value === "" ? null : Number(e.target.value))
                }
                className={`text-xs px-2.5 py-1 rounded-lg border outline-none font-medium cursor-pointer ${
                  L
                    ? "bg-white border-slate-300 text-slate-800 hover:border-slate-400"
                    : "bg-slate-800/90 border-slate-700 text-slate-200 hover:border-slate-600"
                }`}
              >
                {codeblockOptions.map((opt) => (
                  <option key={String(opt.id)} value={opt.id ?? ""}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* SOI Map Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium opacity-70 flex items-center gap-1">
              <Timer className="w-3.5 h-3.5" />
              {t.eoiModal.soiMap}:
            </span>
            <select
              aria-label={t.eoiModal.soiMap}
              value={selectedSoiAddress ?? ""}
              onChange={(e) => setSelectedSoiAddress(Number(e.target.value))}
              className={`text-xs px-2.5 py-1 rounded-lg border outline-none font-medium cursor-pointer max-w-[210px] truncate ${
                L
                  ? "bg-white border-slate-300 text-slate-800 hover:border-slate-400"
                  : "bg-slate-800/90 border-slate-700 text-slate-200 hover:border-slate-600"
              }`}
            >
              {availableSoiMaps.map((mapOpt) => (
                <option key={mapOpt.address} value={mapOpt.address}>
                  {mapOpt.name}
                </option>
              ))}
            </select>
          </div>

          {/* Duration Mode Toggle */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium opacity-70 flex items-center gap-1">
              <Sliders className="w-3.5 h-3.5" />
              {t.eoiModal.durationMode}:
            </span>
            <div
              className={`inline-flex rounded-lg border p-0.5 ${
                L ? "bg-slate-200/80 border-slate-300" : "bg-slate-800 border-slate-700"
              }`}
            >
              <button
                type="button"
                onClick={() => setDurationMode("auto")}
                className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                  durationMode === "auto"
                    ? L
                      ? "bg-white text-blue-600 shadow-sm"
                      : "bg-blue-600 text-white shadow"
                    : "opacity-70 hover:opacity-100"
                }`}
              >
                {t.eoiModal.autoDuration}
              </button>
              <button
                type="button"
                onClick={() => setDurationMode("manual")}
                className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                  durationMode === "manual"
                    ? L
                      ? "bg-white text-blue-600 shadow-sm"
                      : "bg-blue-600 text-white shadow"
                    : "opacity-70 hover:opacity-100"
                }`}
              >
                {t.eoiModal.manualDuration}
              </button>
            </div>

            {durationMode === "manual" && (
              <select
                aria-label={t.eoiModal.manualDuration}
                value={manualDurationIndex}
                onChange={(e) => setManualDurationIndex(Number(e.target.value))}
                className={`text-xs px-2 py-1 rounded-lg border outline-none font-medium cursor-pointer ${
                  L
                    ? "bg-white border-slate-300 text-slate-800"
                    : "bg-slate-800/90 border-slate-700 text-slate-200"
                }`}
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <option key={i} value={i}>
                    Duration 0{i}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Unit & Limiter Controls */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applySoiLimiter}
              onChange={(e) => setApplySoiLimiter(e.target.checked)}
              className="rounded accent-blue-600 cursor-pointer"
            />
            <span className="opacity-80">{t.eoiModal.applyLimiter}</span>
          </label>

          <div
            className={`inline-flex rounded-lg border p-0.5 ${
              L ? "bg-slate-200/80 border-slate-300" : "bg-slate-800 border-slate-700"
            }`}
          >
            <button
              type="button"
              onClick={() => setUnit("atdc")}
              className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                unit === "atdc"
                  ? L
                    ? "bg-white text-blue-600 shadow-sm"
                    : "bg-blue-600 text-white shadow"
                  : "opacity-70 hover:opacity-100"
              }`}
            >
              ° ATDC
            </button>
            <button
              type="button"
              onClick={() => setUnit("btdc")}
              className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                unit === "btdc"
                  ? L
                    ? "bg-white text-blue-600 shadow-sm"
                    : "bg-blue-600 text-white shadow"
                  : "opacity-70 hover:opacity-100"
              }`}
            >
              ° BTDC
            </button>
          </div>

          {/* Refresh / Recalculate Button */}
          <button
            type="button"
            onClick={() => void calculate()}
            disabled={loading}
            title={(t.common as any)?.refresh || "Refresh calculation"}
            className={`px-2 py-1 rounded-lg border text-xs flex items-center gap-1 font-medium transition-colors ${
              L
                ? "bg-white hover:bg-slate-50 border-slate-300 text-slate-700 shadow-sm"
                : "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200"
            }`}
          >
            <RotateCcw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{(t.common as any)?.refresh || "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* ── Summary & Stats Chips ────────────────────────────────────── */}
      {matrixResult && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* Max EOI Indicator */}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
                matrixResult.maxEoiAtdc > 11.0
                  ? L
                    ? "bg-rose-50 border-rose-300 text-rose-800"
                    : "bg-rose-950/30 border-rose-800/50 text-rose-300"
                  : matrixResult.maxEoiAtdc > 8.0
                  ? L
                    ? "bg-amber-50 border-amber-300 text-amber-800"
                    : "bg-amber-950/30 border-amber-800/50 text-amber-300"
                  : L
                  ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                  : "bg-emerald-950/30 border-emerald-800/50 text-emerald-300"
              }`}
            >
              <Flame className="w-4 h-4" />
              <span className="text-xs font-semibold">
                {t.eoiModal.maxEoi}:{" "}
                <span className="font-mono text-sm">
                  {unit === "atdc"
                    ? `+${matrixResult.maxEoiAtdc.toFixed(1)}° ATDC`
                    : `${(-matrixResult.maxEoiAtdc).toFixed(1)}° BTDC`}
                </span>
              </span>
              {matrixResult.maxEoiPoint && (
                <span className="text-[11px] opacity-75 font-mono">
                  (@ {matrixResult.maxEoiPoint.rpm} rpm / {matrixResult.maxEoiPoint.iq} mg)
                </span>
              )}
            </div>

            {/* Breakdown distribution chips */}
            <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              {matrixResult.stats.safe} {t.eoiModal.optimal}
            </span>

            {matrixResult.stats.caution > 0 && (
              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                {matrixResult.stats.caution} {t.eoiModal.caution}
              </span>
            )}

            {matrixResult.stats.danger > 0 && (
              <span className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/30 font-mono font-semibold">
                <span className="w-2 h-2 rounded-full bg-rose-400 animate-ping" />
                {matrixResult.stats.danger} {t.eoiModal.danger}
              </span>
            )}
          </div>

          <div className="text-xs opacity-60 font-mono">
            {matrixResult.rpmAxis.length} × {matrixResult.iqAxis.length} ({matrixResult.stats.total} {t.dtcModal.codesSelected || "cells"})
          </div>
        </div>
      )}

      {/* ── Main 2D Heatmap Matrix Table ────────────────────────────── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center p-12 text-center opacity-70">
          <Timer className="w-8 h-8 animate-spin mb-3 text-blue-500" />
          <p className="text-sm font-medium">Calculating EOI...</p>
        </div>
      ) : error ? (
        <div
          className={`p-6 rounded-xl border text-center ${
            L ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-rose-950/20 border-rose-800/40 text-rose-300"
          }`}
        >
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-rose-500" />
          <p className="font-semibold text-sm">
            {error === "no_maps" ? t.eoiModal.noMapsFound : "Unable to calculate EOI for this ECU."}
          </p>
        </div>
      ) : matrixResult ? (
        <div className="flex flex-col gap-3">
          <div
            className={`overflow-auto border rounded-xl shadow-inner max-h-[380px] ${
              L ? "bg-white border-slate-300" : oled ? "bg-black border-neutral-800" : "bg-slate-950 border-slate-800"
            }`}
          >
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr
                  className={`sticky top-0 z-20 border-b ${
                    L ? "bg-slate-100 border-slate-300" : "bg-slate-900 border-slate-800"
                  }`}
                >
                  <th className="p-2 text-left font-semibold text-slate-500 border-r min-w-[75px] sticky left-0 z-30 bg-inherit">
                    RPM \ IQ
                  </th>
                  {matrixResult.iqAxis.map((iq, idx) => (
                    <th key={idx} className="p-2 text-center font-mono font-medium opacity-80 min-w-[58px]">
                      {iq}
                      <span className="text-[10px] block opacity-60 font-sans">mg</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixResult.rpmAxis.map((rpm, rIdx) => (
                  <tr key={rIdx} className="border-b border-slate-800/30 hover:bg-blue-500/5">
                    <td
                      className={`p-1.5 font-mono font-medium text-slate-400 border-r sticky left-0 z-10 ${
                        L ? "bg-slate-100" : "bg-slate-900"
                      }`}
                    >
                      {rpm}
                    </td>
                    {matrixResult.cells[rIdx]?.map((cell, cIdx) => {
                      const isSelected =
                        selectedCell?.rpm === cell.rpm && selectedCell?.iq === cell.iq;
                      const val = unit === "atdc" ? cell.eoiAtdc : cell.eoiBtdc;
                      const sign = val > 0 ? "+" : "";

                      return (
                        <td
                          key={cIdx}
                          onClick={() => setSelectedCell(cell)}
                          onMouseEnter={() => setSelectedCell(cell)}
                          className={getCellClasses(cell.status, isSelected)}
                          title={`${cell.rpm} rpm / ${cell.iq} mg | SOI: ${cell.soi}° | Dur: ${cell.duration}° | EOI: ${cell.eoiAtdc}° ATDC`}
                        >
                          {sign}
                          {val.toFixed(1)}°
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Cell Inspector Panel ─────────────────────────────────── */}
          {selectedCell && (
            <div
              className={`p-3.5 rounded-xl border flex flex-wrap items-center justify-between gap-4 ${
                L
                  ? "bg-slate-50 border-slate-200"
                  : oled
                  ? "bg-neutral-950 border-neutral-800"
                  : "bg-slate-900/60 border-slate-800"
              }`}
            >
              <div className="flex flex-wrap items-center gap-4">
                {/* Operating Point */}
                <div className="flex flex-col">
                  <span className="text-[11px] uppercase tracking-wider opacity-60 font-medium">
                    {t.eoiModal.cellInspector}
                  </span>
                  <span className="font-mono text-sm font-bold text-blue-400">
                    {selectedCell.rpm} <span className="text-xs font-normal opacity-70">rpm</span> × {selectedCell.iq}{" "}
                    <span className="text-xs font-normal opacity-70">mg/st</span>
                  </span>
                </div>

                <div className="h-7 w-[1px] bg-slate-700/40 hidden sm:block" />

                {/* SOI Value */}
                <div className="flex flex-col">
                  <span className="text-[11px] opacity-60 font-medium">{t.eoiModal.soiValue}</span>
                  <span className="font-mono text-xs font-semibold text-slate-300">
                    {selectedCell.soi.toFixed(2)}° <span className="text-[10px] opacity-70">BTDC</span>
                  </span>
                </div>

                <div className="h-7 w-[1px] bg-slate-700/40 hidden sm:block" />

                {/* Duration Value */}
                <div className="flex flex-col">
                  <span className="text-[11px] opacity-60 font-medium">{t.eoiModal.durationValue}</span>
                  <span className="font-mono text-xs font-semibold text-slate-300">
                    {selectedCell.duration.toFixed(2)}°{" "}
                    <span className="text-[10px] opacity-70">({selectedCell.activeDurationDesc})</span>
                  </span>
                </div>

                <div className="h-7 w-[1px] bg-slate-700/40 hidden sm:block" />

                {/* Calculated EOI */}
                <div className="flex flex-col">
                  <span className="text-[11px] opacity-60 font-medium">{t.eoiModal.eoiValue}</span>
                  <span
                    className={`font-mono text-sm font-bold ${
                      selectedCell.status === "danger"
                        ? "text-rose-400"
                        : selectedCell.status === "caution"
                        ? "text-amber-400"
                        : "text-emerald-400"
                    }`}
                  >
                    {selectedCell.eoiAtdc >= 0 ? `+${selectedCell.eoiAtdc.toFixed(2)}°` : `${selectedCell.eoiAtdc.toFixed(2)}°`}{" "}
                    <span className="text-xs font-normal">ATDC</span>
                    <span className="text-[10px] opacity-60 font-normal ml-1">
                      ({selectedCell.eoiBtdc.toFixed(2)}° BTDC)
                    </span>
                  </span>
                </div>
              </div>

              {/* Status Badge & Advisory */}
              <div className="flex items-center gap-3">
                {getStatusBadge(selectedCell.status)}
                <span className="text-xs opacity-70 hidden md:inline-block max-w-[280px]">
                  {selectedCell.status === "safe"
                    ? t.eoiModal.optimalDesc
                    : selectedCell.status === "caution"
                    ? t.eoiModal.cautionDesc
                    : selectedCell.status === "danger"
                    ? t.eoiModal.dangerDesc
                    : t.eoiModal.earlyDesc}
                </span>
              </div>
            </div>
          )}

          {/* ── Legend ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between text-xs opacity-75 px-1 pt-1 border-t border-slate-800/40">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-emerald-500/80 inline-block" />
                <span>{t.eoiModal.optimal}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-amber-500/80 inline-block" />
                <span>{t.eoiModal.caution}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-rose-500/80 inline-block" />
                <span>{t.eoiModal.danger}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-sky-500/80 inline-block" />
                <span>{t.eoiModal.early}</span>
              </div>
            </div>
            <div className="text-[11px] opacity-60 italic">
              Formula: EOI = Duration - SOI (° ATDC)
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
