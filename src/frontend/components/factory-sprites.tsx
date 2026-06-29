import React from "react";

// Hand-built pixel-art SVG sprites in the *style* of Factorio — no ripped game
// art (Factorio's sprites are Wube Software's copyright). Limited industrial
// palette, crisp edges, CSS-animated moving parts (cogs spin, drill bits bob,
// inserter arms swing, logistic bots hover). All driven by classes defined in
// global.css (.spr-*).

const STEEL = "#aab0b8";
const STEEL_D = "#71777f";
const STEEL_DD = "#42464c";
const BLUE = "#4f7cab";
const BLUE_D = "#2f5074";
const YEL = "#e6bd3f";
const YEL_D = "#a9851f";
const BLK = "#1a1206";
const COPPER = "#c8803a";
const RED = "#e5484d";

/** Parametric cog — teeth generated around the origin so it spins cleanly via CSS. */
export function Cog({
  cx,
  cy,
  r,
  spin = "spr-spin",
  color = STEEL,
}: {
  cx: number;
  cy: number;
  r: number;
  spin?: string;
  color?: string;
}) {
  const teeth = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <g transform={`translate(${cx} ${cy})`}>
      {/* spinning group carries NO attribute transform, so the CSS rotate isn't
          clobbered; transform-box:fill-box centres it on its own bbox (the origin). */}
      <g className={spin}>
        {teeth.map((a) => (
          <rect
            key={a}
            x={-r * 0.2}
            y={-r * 1.16}
            width={r * 0.4}
            height={r * 0.42}
            fill={color}
            transform={`rotate(${a})`}
          />
        ))}
        <circle r={r * 0.86} fill={color} />
        <circle r={r * 0.4} fill={BLK} />
        <circle r={r * 0.18} fill={color} />
      </g>
    </g>
  );
}

/** Assembling machine — steel body, blue window, hazard base, two counter-rotating cogs. */
export function Assembler({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className="spr">
      {/* hazard base */}
      <rect x="3" y="26" width="26" height="5" fill={YEL} />
      <g stroke={BLK} strokeWidth="2.4">
        <line x1="4" y1="31" x2="9" y2="26" />
        <line x1="10" y1="31" x2="15" y2="26" />
        <line x1="16" y1="31" x2="21" y2="26" />
        <line x1="22" y1="31" x2="27" y2="26" />
      </g>
      {/* body */}
      <rect x="4" y="11" width="24" height="16" fill={STEEL_D} stroke={STEEL_DD} shapeRendering="crispEdges" />
      <rect x="4" y="11" width="24" height="3" fill={STEEL} shapeRendering="crispEdges" />
      {/* blue assembler window */}
      <rect x="10" y="16" width="12" height="8" fill={BLUE_D} shapeRendering="crispEdges" />
      <rect x="11" y="17" width="10" height="6" fill={BLUE} shapeRendering="crispEdges" />
      {/* corner bolts */}
      <rect x="5.5" y="24.5" width="2" height="2" fill={STEEL_DD} />
      <rect x="24.5" y="24.5" width="2" height="2" fill={STEEL_DD} />
      {/* cogs on top */}
      <Cog cx={11} cy={10} r={5.2} spin="spr-spin" color={STEEL} />
      <Cog cx={21} cy={10} r={5.2} spin="spr-spin-rev" color={STEEL} />
    </svg>
  );
}

/** Electric mining drill — yellow body, a coloured source band, a bobbing bit. */
export function Drill({ size = 24, color = YEL }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spr">
      {/* legs */}
      <rect x="3" y="18" width="4" height="4" fill={STEEL_DD} />
      <rect x="17" y="18" width="4" height="4" fill={STEEL_DD} />
      {/* body */}
      <rect x="3" y="5" width="18" height="14" fill={YEL} stroke={BLK} strokeWidth="1" shapeRendering="crispEdges" />
      <rect x="3" y="5" width="18" height="3" fill={color} shapeRendering="crispEdges" />
      {/* drill shaft opening */}
      <rect x="9" y="15" width="6" height="7" fill={BLK} shapeRendering="crispEdges" />
      {/* bobbing bit */}
      <g className="spr-bob">
        <path d="M9 14 L12 21 L15 14 Z" fill={STEEL} />
        <path d="M10.5 14 L12 18 L13.5 14 Z" fill={STEEL_DD} />
      </g>
      {/* little cog detail */}
      <Cog cx={17.5} cy={11} r={3} spin="spr-spin" color={YEL_D} />
    </svg>
  );
}

/** Inserter — pivoting arm that swings, carrying a cog. Decorative on belt ends. */
export function Inserter({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spr">
      <rect x="9" y="17" width="6" height="5" fill={STEEL_D} stroke={STEEL_DD} strokeWidth="0.6" />
      <circle cx="12" cy="18" r="2" fill={STEEL_DD} />
      <g className="spr-arm">
        <rect x="11" y="6" width="2" height="12" fill={STEEL} />
        <Cog cx={12} cy={6} r={3} spin="spr-spin" color={COPPER} />
      </g>
    </svg>
  );
}

/** Steel chest — the buffer. */
export function Chest({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spr">
      <rect x="3" y="8" width="18" height="13" fill={STEEL_D} stroke={STEEL_DD} strokeWidth="1" shapeRendering="crispEdges" />
      <rect x="3" y="8" width="18" height="4" fill={STEEL} shapeRendering="crispEdges" />
      <rect x="3" y="19" width="18" height="2" fill={STEEL_DD} shapeRendering="crispEdges" />
      <rect x="10" y="11" width="4" height="4" fill={STEEL_DD} shapeRendering="crispEdges" />
      <rect x="5" y="9.5" width="1.6" height="1.6" fill={STEEL_DD} />
      <rect x="17.4" y="9.5" width="1.6" height="1.6" fill={STEEL_DD} />
    </svg>
  );
}

/** Alarm siren — a red beacon that flashes. Marks the "awaiting input" station. */
export function Siren({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="spr">
      <rect x="6" y="17" width="12" height="5" fill={STEEL_D} stroke={STEEL_DD} strokeWidth="1" shapeRendering="crispEdges" />
      <rect x="8" y="13" width="8" height="4" fill={STEEL_DD} shapeRendering="crispEdges" />
      {/* dome */}
      <path d="M8 13 a4 4 0 0 1 8 0 Z" fill={RED} className="spr-flash" />
      <circle cx="12" cy="11" r="1.6" fill="#ffd2d2" className="spr-flash" />
      {/* glow */}
      <circle cx="12" cy="11" r="6" fill={RED} opacity="0.18" className="spr-flash" />
    </svg>
  );
}

/** Logistic bot — hovers and flaps, carrying a package. Drifts over the island. */
export function Bot({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className="spr">
      <g className="spr-hover">
        <rect x="1" y="6" width="5" height="2" fill={STEEL} className="spr-flap" />
        <rect x="14" y="6" width="5" height="2" fill={STEEL} className="spr-flap" />
        <rect x="7" y="5" width="6" height="6" fill={BLUE} stroke={BLUE_D} strokeWidth="0.6" />
        <rect x="8" y="6" width="4" height="2" fill="#9ec8ef" />
        <rect x="8" y="11" width="4" height="4" fill={COPPER} stroke={BLK} strokeWidth="0.5" />
      </g>
    </svg>
  );
}
