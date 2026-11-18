"use client";
import { useEffect, useState, type CSSProperties } from "react";

export type FlowState = "sending" | "ok" | "bad" | "stopped";

const ARC = "M82 58 Q160 -18 238 58";
const CRASH = "M82 58 Q128 4 166 20 Q194 32 204 112";
const CONFETTI = [
  [-46, -44, "#2aabee"], [-30, -58, "#ffffff"], [-12, -64, "#3fcf8e"], [10, -62, "#2aabee"], [30, -56, "#ffffff"],
  [48, -40, "#3fcf8e"], [58, -14, "#2aabee"], [54, 14, "#ffffff"], [-56, -16, "#3fcf8e"], [-52, 12, "#ffffff"],
  [-26, 34, "#2aabee"], [26, 36, "#3fcf8e"],
] as const;

/**
 * Telegram -> GitHub. Paper plane flies the arc with a tapered trail, GitHub's ring fills with the real progress.
 * `ok` lands + confetti + check, `bad` nose-dives + red X, `stopped` parks. The svg is re-keyed per state so results play once.
 */
export function SendFlow({ state, pct }: { state: FlowState; pct?: number }) {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    setReduce(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  }, []);

  const looping = state === "sending";
  const dur = looping ? 2.8 : state === "ok" ? 1.1 : 1.2;
  const path = state === "bad" ? CRASH : ARC;
  const rc = looping ? "indefinite" : "1";
  const label = looping ? "Mengirim" : state === "ok" ? "Berhasil" : state === "bad" ? "Gagal" : "Dihentikan";
  const ring = state === "ok" ? 100 : Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const showRing = pct !== undefined || state === "ok";

  const timing = looping
    ? { keyTimes: "0;.78;1", keyPoints: "0;1;1", keySplines: ".45 0 .2 1;0 0 1 1", op: "0;1;1;0;0", opT: "0;.07;.74;.82;1" }
    : state === "ok"
      ? { keyTimes: "0;1", keyPoints: "0;1", keySplines: ".45 0 .25 1", op: "0;1;1;0", opT: "0;.08;.9;1" }
      : { keyTimes: "0;1", keyPoints: "0;1", keySplines: ".45 0 .25 1", op: "0;1;1;0", opT: "0;.08;.84;1" };

  const plane = (
    <g>
      <path d="M15 0 L-11 -10 L-6 0 Z" fill="#ffffff" />
      <path d="M15 0 L-6 0 L-11 10 Z" fill="#b9dcf7" />
      <path d="M-6 0 L-3 6 L-11 10 Z" fill="#6fb2e6" />
    </g>
  );
  const parked = state === "ok" ? "translate(236 58) rotate(38)" : state === "bad" ? "translate(176 26) rotate(60)" : "translate(160 10)";
  const style = { "--d": `${dur}s` } as CSSProperties;

  return (
    <svg key={state} className={`sf sf-${state}`} style={style} viewBox="0 0 320 132" role="img" aria-label={label}>
      <path d={ARC} className="sf-guide" />
      <path d="M80 100 H240" className="sf-wire" />

      {/* Telegram */}
      <g className="sf-L">
        {looping && <circle cx="50" cy="80" r="24" className="sf-emit" />}
        <circle cx="50" cy="80" r="24" fill="#2aabee" />
        <path d="M61 70 L40 78.500 L47 82 L49 91 L53 86 L59 90 Z" fill="#fff" />
        <path d="M47 82 L58 73 L49.500 84.500 Z" fill="#b9dcf7" />
      </g>

      {/* GitHub + progress ring */}
      <g className="sf-R">
        {looping && <circle cx="270" cy="80" r="24" className="sf-hit" />}
        {showRing && (
          <>
            <circle cx="270" cy="80" r="30" className="sf-track" />
            <circle cx="270" cy="80" r="30" pathLength={100} className="sf-prog" style={{ strokeDasharray: `${ring} 100` }} />
          </>
        )}
        <circle cx="270" cy="80" r="24" fill="#12161d" stroke="rgba(255,255,255,.2)" strokeWidth="1.2" />
        <g transform="translate(270 80)" fill="none" stroke="#eaf0fb" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="-6" cy="-9" r="3" />
          <circle cx="-6" cy="10" r="3" />
          <circle cx="8" cy="-3" r="3" />
          <path d="M-6 -6v13M8 0c0 6-14 3-14 10" />
        </g>
      </g>

      {state !== "stopped" && [
        { w: 5, l: 10, o: 0.28 },
        { w: 3.600, l: 18, o: 0.5 },
        { w: 2.200, l: 26, o: 0.95 },
      ].map((t, i) => (
        <path key={i} d={path} pathLength={100} className="sf-tr" style={{ strokeWidth: t.w, opacity: t.o, "--l": `${t.l}px` } as CSSProperties} />
      ))}

      {state !== "stopped" && (reduce ? (
        <g transform={parked}>{plane}</g>
      ) : (
        <g opacity="0">
          <g className={state === "bad" ? "sf-fall" : undefined}>{plane}</g>
          <animateMotion dur={`${dur}s`} repeatCount={rc} fill="freeze" path={path} rotate="auto" calcMode="spline" keyTimes={timing.keyTimes} keyPoints={timing.keyPoints} keySplines={timing.keySplines} />
          <animate attributeName="opacity" dur={`${dur}s`} repeatCount={rc} fill="freeze" values={timing.op} keyTimes={timing.opT} />
        </g>
      ))}

      {state === "ok" && (
        <>
          {CONFETTI.map(([x, y, c], i) => (
            <rect key={i} x="267" y="77" width={i % 2 ? 5 : 4} height={i % 3 ? 3 : 6} rx="1" fill={c} className="sf-conf" style={{ "--x": `${x}px`, "--y": `${y}px`, "--r": `${(i * 97) % 360}deg`, animationDelay: `${1.05 + (i % 4) * 0.03}s` } as CSSProperties} />
          ))}
          <circle cx="270" cy="80" r="24" className="sf-pulse" />
          <g transform="translate(270 80)"><g className="sf-badge ok"><circle r="14" fill="#3fcf8e" /><path d="M-6 .5l4.200 4.200L6.500 -4" fill="none" stroke="#04140b" strokeWidth="2.800" strokeLinecap="round" strokeLinejoin="round" /></g></g>
        </>
      )}
      {state === "bad" && (
        <>
          {[[-9, 0], [5, -5], [13, 3]].map(([x, y], i) => (
            <circle key={i} cx={204 + x} cy={112 + y} r={4 - i} className="sf-puff" style={{ animationDelay: `${1 + i * 0.07}s` }} />
          ))}
          <g transform="translate(270 80)"><g className="sf-badge bad"><circle r="14" fill="#ff6b6b" /><path d="M-5 -5l10 10M5 -5l-10 10" fill="none" stroke="#1d0606" strokeWidth="2.800" strokeLinecap="round" /></g></g>
        </>
      )}
      {state === "stopped" && (
        <g transform="translate(270 80)"><g className="sf-badge"><circle r="14" fill="#8a94a6" /><path d="M-3.500 -5v10M3.500 -5v10" stroke="#10131a" strokeWidth="3" strokeLinecap="round" /></g></g>
      )}
    </svg>
  );
}
