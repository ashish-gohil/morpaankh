/* global React, Icon, FabricSwatch */
// Product card using FabricSwatch placeholders + polished hover motion

const ProductCard = ({ p, onClick }) => {
  const [hover, setHover] = React.useState(false);
  const [colorIdx, setColorIdx] = React.useState(0);
  const color = p.colors[colorIdx];
  const stockLow = p.sizes.some((s) => p.stockBySize[s] > 0 && p.stockBySize[s] <= 3);
  return (
    <article
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onClick && onClick(p)}
      style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: 14, position: "relative" }}
    >
      <div style={{
        position: "relative",
        transition: "transform 480ms cubic-bezier(0.22, 1, 0.36, 1)",
        transform: hover ? "translateY(-4px)" : "translateY(0)",
      }}>
        <div style={{
          position: "relative",
          overflow: "hidden",
          transition: "box-shadow 480ms cubic-bezier(0.22, 1, 0.36, 1)",
          boxShadow: hover ? "0 24px 48px -28px rgba(44,40,38,0.25)" : "none",
        }}>
          {/* Active (front) swatch */}
          <div style={{
            transition: "opacity 600ms cubic-bezier(0.22,1,0.36,1), transform 1200ms cubic-bezier(0.22,1,0.36,1)",
            opacity: hover ? 0 : 1,
            transform: hover ? "scale(1.03)" : "scale(1)",
          }}>
            <FabricSwatch
              name={p.name}
              gsm={p.fabric.gsm}
              color={color.hex}
              colorName={color.name}
              weave={p.fabric.weaveKey}
              aspect="3 / 4"
            />
          </div>
          {/* Back-swatch revealed on hover (uses second colour if any) */}
          <div style={{
            position: "absolute", inset: 0,
            transition: "opacity 600ms cubic-bezier(0.22,1,0.36,1), transform 1200ms cubic-bezier(0.22,1,0.36,1)",
            opacity: hover ? 1 : 0,
            transform: hover ? "scale(1)" : "scale(1.04)",
          }}>
            <FabricSwatch
              name={p.name}
              gsm={p.fabric.gsm}
              color={(p.colors[1] || p.colors[0]).hex}
              colorName={(p.colors[1] || p.colors[0]).name}
              weave={p.fabric.weaveKey === "plain" ? "voile" : "plain"}
              aspect="3 / 4"
            />
          </div>

          {/* badges */}
          <div style={{ position: "absolute", top: 12, left: 12, display: "flex", flexDirection: "column", gap: 6, zIndex: 2 }}>
            {p.tags.includes("new") && <span className="tag tag-charcoal">New</span>}
            {p.tags.includes("bestseller") && <span className="tag tag-sage">Bestseller</span>}
            {p.tags.includes("festive") && <span className="tag tag-terracotta">Festive</span>}
          </div>
          {p.compareAt && (
            <div style={{ position: "absolute", top: 12, right: 12, zIndex: 2 }}>
              <span className="tag" style={{ background: "var(--charcoal)", color: "var(--cream)", borderColor: "transparent" }}>
                –{Math.round((1 - p.price / p.compareAt) * 100)}%
              </span>
            </div>
          )}

          {/* hover overlay — slide-up CTA (desktop only) */}
          <div className="pc-overlay" style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "flex-end", justifyContent: "center",
            padding: 16,
            pointerEvents: hover ? "auto" : "none",
            zIndex: 3,
          }}>
            <div style={{
              width: "100%", maxWidth: 280,
              transition: "transform 480ms cubic-bezier(0.22,1,0.36,1), opacity 360ms",
              transform: hover ? "translateY(0)" : "translateY(120%)",
              opacity: hover ? 1 : 0,
            }}>
              <button className="btn tapi-arrow-slide" style={{ background: "var(--charcoal)", color: "var(--cream)", width: "100%", height: 44, fontSize: 12 }}>
                Quick view {Icon.arrowRight}
              </button>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        /* Touch devices: don't rely on hover for "Quick View" CTA */
        @media (hover: none) and (pointer: coarse) {
          .pc-overlay { display: none !important; }
        }
      `}</style>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h3 className="serif" style={{ fontSize: 19, margin: 0, fontWeight: 500, transition: "color 240ms var(--ease)", color: hover ? "var(--terracotta)" : "var(--charcoal)" }}>
            {p.fullName}
          </h3>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span className="tnum" style={{ fontSize: 14, fontWeight: 500 }}>{p.currency}{p.price.toLocaleString("en-IN")}</span>
            {p.compareAt && <span className="tnum" style={{ fontSize: 12, color: "var(--muted)", textDecoration: "line-through" }}>{p.currency}{p.compareAt.toLocaleString("en-IN")}</span>}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 12, color: "var(--warm-grey)" }}>{p.subtitle}</span>
          <div style={{ display: "flex", gap: 5, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            {p.colors.map((c, i) => (
              <button
                key={c.name}
                onMouseEnter={() => setColorIdx(i)}
                aria-label={c.name}
                style={{
                  width: 14, height: 14, borderRadius: "50%",
                  background: c.hex,
                  border: i === colorIdx ? "1px solid var(--charcoal)" : "1px solid var(--hairline-2)",
                  outline: i === colorIdx ? "1.5px solid var(--cream)" : "none",
                  outlineOffset: -3,
                  transition: "transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)",
                  transform: i === colorIdx ? "scale(1.1)" : "scale(1)",
                }}
              />
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4, fontSize: 11, color: "var(--muted)" }}>
          <span>★ {p.rating}</span>
          <span style={{ width: 2, height: 2, background: "var(--muted)", borderRadius: "50%" }} />
          <span>{p.reviewCount} reviews</span>
          <span style={{ width: 2, height: 2, background: "var(--muted)", borderRadius: "50%" }} />
          <span className="tnum">{p.fabric.gsm} GSM</span>
          {stockLow && (
            <>
              <span style={{ width: 2, height: 2, background: "var(--muted)", borderRadius: "50%" }} />
              <span style={{ color: "var(--terracotta)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span className="tapi-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--terracotta)" }} />
                Low stock
              </span>
            </>
          )}
        </div>
      </div>
    </article>
  );
};

window.ProductCard = ProductCard;
