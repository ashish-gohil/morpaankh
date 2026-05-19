/* global React */
/*
  FabricSwatch — text-only / fabric-swatch placeholder
  A warm tinted block with woven CSS texture, product name (serif),
  GSM number, and color name. Used in place of product photography.

  Props: { name, gsm, color, weave, aspect, size, showMeta, accent }
  weave: 'plain' | 'satin' | 'twill' | 'voile' | 'dobby' | 'blockprint'
*/

const weavePattern = (weave, color) => {
  const c = color || "#B7472A";
  // Compute a soft tint by mixing with cream
  const dim = (alpha = 0.18) => {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  // Background — warm cream tinted with product color
  const base = `linear-gradient(135deg, ${dim(0.08)}, ${dim(0.18)}), var(--cream-2)`;

  const patterns = {
    plain: `
      repeating-linear-gradient(90deg, ${dim(0.08)} 0 1px, transparent 1px 4px),
      repeating-linear-gradient(0deg, ${dim(0.08)} 0 1px, transparent 1px 4px),
      ${base}
    `,
    satin: `
      repeating-linear-gradient(135deg, ${dim(0.12)} 0 2px, transparent 2px 8px),
      ${base}
    `,
    twill: `
      repeating-linear-gradient(45deg, ${dim(0.10)} 0 2px, transparent 2px 6px),
      ${base}
    `,
    voile: `
      radial-gradient(circle at 1px 1px, ${dim(0.15)} 0.5px, transparent 1.5px) 0 0 / 6px 6px,
      ${base}
    `,
    dobby: `
      radial-gradient(circle at 50% 50%, ${dim(0.22)} 1.5px, transparent 2.5px) 0 0 / 10px 10px,
      ${base}
    `,
    blockprint: `
      radial-gradient(ellipse at center, ${dim(0.25)} 2px, transparent 3.5px) 0 0 / 24px 24px,
      radial-gradient(ellipse at 12px 12px, ${dim(0.18)} 1px, transparent 2px) 0 0 / 24px 24px,
      ${base}
    `,
  };
  return patterns[weave] || patterns.plain;
};

const FabricSwatch = ({
  name = "Saanjh",
  gsm = 120,
  color = "#B7472A",
  colorName = "Terracotta",
  weave = "plain",
  aspect = "3 / 4",
  size = "md", // sm, md, lg
  showMeta = true,
  accent = "var(--terracotta)",
  withCorners = true,
}) => {
  const scale = size === "sm" ? 0.78 : size === "lg" ? 1.4 : 1;
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: aspect,
        background: weavePattern(weave, color),
        backgroundColor: "var(--cream-2)",
        overflow: "hidden",
        borderRadius: "var(--r-xs)",
        color: "var(--charcoal)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 18 * scale,
        boxShadow: "inset 0 0 0 1px rgba(44,40,38,0.06)",
      }}
    >
      {/* Corner crop marks */}
      {withCorners && (
        <>
          <Corner pos="tl" />
          <Corner pos="tr" />
          <Corner pos="bl" />
          <Corner pos="br" />
        </>
      )}

      {/* Top — collection label + color chip */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <span style={{
          fontSize: 9 * scale,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "var(--warm-grey)",
          fontWeight: 500,
          paddingTop: 4 * scale,
        }}>
          Tapi · {weave}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 10 * scale, height: 10 * scale,
            background: color, borderRadius: "50%",
            border: "1px solid rgba(44,40,38,0.18)"
          }} />
          <span style={{ fontSize: 9 * scale, letterSpacing: "0.06em", color: "var(--warm-grey)" }}>
            {colorName}
          </span>
        </div>
      </div>

      {/* Center — name (large serif) */}
      <div style={{ textAlign: "center", padding: `${16 * scale}px 0` }}>
        <div style={{
          fontFamily: "var(--font-serif)",
          fontSize: 38 * scale,
          lineHeight: 1,
          fontWeight: 500,
          letterSpacing: "-0.012em",
          color: "var(--charcoal)",
        }}>
          {name}
        </div>
        {showMeta && (
          <div style={{
            marginTop: 10 * scale,
            fontFamily: "var(--font-sans)",
            fontStyle: "italic",
            fontFamily: "var(--font-serif)",
            fontSize: 13 * scale,
            color: "var(--warm-grey)",
          }}>
            <em>fabric study no. {String(Math.floor(gsm)).padStart(3, "0")}</em>
          </div>
        )}
      </div>

      {/* Bottom — GSM + cross */}
      {showMeta && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
          <div>
            <div style={{ fontSize: 9 * scale, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--warm-grey)" }}>GSM</div>
            <div className="tnum" style={{ fontFamily: "var(--font-serif)", fontSize: 22 * scale, lineHeight: 1, marginTop: 2 }}>{gsm}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9 * scale, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--warm-grey)" }}>Weave</div>
            <div style={{ fontFamily: "var(--font-serif)", fontSize: 14 * scale, fontStyle: "italic", marginTop: 2 }}>{weave}</div>
          </div>
        </div>
      )}
    </div>
  );
};

const Corner = ({ pos }) => {
  const len = 14;
  const off = 10;
  const styles = {
    tl: { top: off, left: off, borderTop: "1px solid var(--charcoal)", borderLeft: "1px solid var(--charcoal)" },
    tr: { top: off, right: off, borderTop: "1px solid var(--charcoal)", borderRight: "1px solid var(--charcoal)" },
    bl: { bottom: off, left: off, borderBottom: "1px solid var(--charcoal)", borderLeft: "1px solid var(--charcoal)" },
    br: { bottom: off, right: off, borderBottom: "1px solid var(--charcoal)", borderRight: "1px solid var(--charcoal)" },
  };
  return (
    <span aria-hidden="true" style={{
      position: "absolute",
      width: len, height: len,
      opacity: 0.55,
      ...styles[pos],
    }} />
  );
};

window.FabricSwatch = FabricSwatch;
