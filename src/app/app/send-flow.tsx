"use client";
import { useEffect, useId, useState, type CSSProperties } from "react";

export type FlowState = "sending" | "ok" | "bad" | "stopped";

/**
 * Paper plane flying from Telegram to GitHub. `sending` loops; `ok` lands with a burst; `bad` stalls and drops.
 * Purely visual (the progress numbers live next to it). The svg is re-keyed on every state change so the result plays once.
 */
export function SendFlow({ state }: { state: FlowState }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [reduce, setReduce] = useState(false);
  useEffect(() => { setReduce(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches); }, []);
  const ARC = "M72 70 Q160 -16 248 70";
  const CRASH = "M72 70 Q122 18 170 30 Q198 38 208 122";
  const looping = state === "sending";
  const dur = looping ? "2.4s" : state === "ok" ? "1.3s" : "1.15s";
  const rc = looping ? "indefinite" : "1";
  const spline = looping ? ".4 0 .3 1" : ".5 0 .6 1";
  const fade = state === "ok" ? "0;1;1;0" : state === "bad" ? "0;1;1;0" : "0;1;1;0";
  const fadeT = state === "bad" ? "0;.1;.78;1" : "0;.08;.9;1";
  const label = state === "sending" ? "Mengirim" : state === "ok" ? "Berhasil" : state === "bad" ? "Gagal" : "Dihentikan";
  const plane = (
    <g className="sf-shape">
      <path d="M13 0 L-10 -8 L-6 0 Z" fill="#ffffff" />
      <path d="M13 0 L-6 0 L-10 8 Z" fill="#bfe0ff" />
      <path d="M-6 0 L-2 4.500 L-10 8 Z" fill="#7db9f0" />
    </g>
  );
  const static_ = state === "ok" ? "translate(246 70) rotate(40)" : state === "bad" ? "translate(176 34) rotate(70)" : "translate(160 18)";
  const sparks = [[-30, -34, "#6cb6ff"], [28, -38, "#5fdc95"], [-40, 6, "#fff"], [44, 4, "#6cb6ff"], [-18, 40, "#5fdc95"], [20, 42, "#fff"], [0, -48, "#6cb6ff"], [52, -22, "#fff"]] as const;
  return (
    <svg key={state} className={`sf sf-${state}`} viewBox="0 0 320 132" role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${uid}b`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7cc4ff" /><stop offset="1" stopColor="#2573d4" /></linearGradient>
        <linearGradient id={`${uid}g`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3a4254" /><stop offset="1" stopColor="#0f131b" /></linearGradient>
        <filter id={`${uid}f`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" /></filter>
      </defs>

      <path d={ARC} className="sf-trail" />
      {looping && <><circle cx="46" cy="84" r="26" className="sf-rip" /><circle cx="274" cy="84" r="26" className="sf-rip r2" /></>}

      <g className="sf-nodeL">
        <circle cx="46" cy="84" r="26" fill={`url(#${uid}b)`} />
        <ellipse cx="38" cy="70" rx="14" ry="8" fill="#fff" opacity=".28" />
        <g transform="translate(46 84) scale(1.1)"><path d="M12 -9 L-11 -1 L-5 2 L-3 10 L1 5 L6 9 Z" fill="#fff" /></g>
      </g>
      <g className="sf-nodeR">
        <circle cx="274" cy="84" r="26" fill={`url(#${uid}g)`} stroke="rgba(255,255,255,.22)" strokeWidth="1.2" />
        <g transform="translate(274 84)" fill="none" stroke="#e8eefc" strokeWidth="2.200" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="-6" cy="-9" r="3" /><circle cx="-6" cy="10" r="3" /><circle cx="8" cy="-3" r="3" /><path d="M-6 -6v13M8 0c0 6-14 3-14 10" />
        </g>
      </g>

      {state !== "stopped" && !reduce && looping && [0.12, 0.24, 0.36].map((d, i) => (
        <g key={d} opacity="0">
          <circle r={2.4 - i * 0.5} fill="#9ad0ff" />
          <animateMotion dur={dur} begin={`${d}s`} repeatCount={rc} path={ARC} calcMode="spline" keyTimes="0;1" keySplines={spline} />
          <animate attributeName="opacity" dur={dur} begin={`${d}s`} repeatCount={rc} values={`0;${0.7 - i * 0.2};${0.7 - i * 0.2};0`} keyTimes={fadeT} />
        </g>
      ))}

      {state !== "stopped" && (reduce ? (
        <g transform={static_}>{plane}</g>
      ) : (
        <g opacity="0">
          {plane}
          <animateMotion dur={dur} repeatCount={rc} fill="freeze" path={state === "bad" ? CRASH : ARC} rotate="auto" calcMode="spline" keyTimes="0;1" keySplines={spline} />
          <animate attributeName="opacity" dur={dur} repeatCount={rc} fill="freeze" values={fade} keyTimes={fadeT} />
        </g>
      ))}

      {state === "ok" && sparks.map(([x, y, c], i) => (
        <circle key={i} cx="274" cy="84" r={i % 3 === 0 ? 3 : 2} fill={c} className="sf-spark" style={{ "--x": `${x}px`, "--y": `${y}px` } as CSSProperties} />
      ))}
      {(state === "ok" || state === "bad") && (
        <>
          <circle cx="274" cy="84" r="26" className="sf-ring" />
          <g transform="translate(296 58)">
            <g className="sf-badge">
              <circle r="12" fill={state === "ok" ? "#5fdc95" : "#ff7b7b"} />
              {state === "ok"
                ? <path d="M-5 0.500l3.500 3.500L5.500 -3.500" fill="none" stroke="#04140b" strokeWidth="2.600" strokeLinecap="round" strokeLinejoin="round" />
                : <path d="M-4.500 -4.500l9 9M4.500 -4.500l-9 9" fill="none" stroke="#1d0606" strokeWidth="2.600" strokeLinecap="round" />}
            </g>
          </g>
        </>
      )}
      {state === "bad" && [[-8, 0], [6, -4], [12, 4]].map(([x, y], i) => (
        <circle key={i} cx={208 + x} cy={118 + y} r={3 - i * 0.6} className="sf-puff" style={{ animationDelay: `${0.95 + i * 0.08}s` }} />
      ))}
    </svg>
  );
}
