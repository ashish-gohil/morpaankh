/* global React, Icon, FabricSwatch */
// Cart drawer + Size Guide modal

const { useEffect: useDrawerEffect, useState: useDrawerState } = React;

const CartDrawer = ({ open, onClose, items, removeItem, updateQty }) => {
  useDrawerEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const shipping = subtotal >= 2499 ? 0 : 79;
  const total = subtotal + shipping;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 150,
        background: "rgba(44,40,38,0.5)",
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        transition: "opacity 280ms cubic-bezier(0.22,1,0.36,1)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: "100%", maxWidth: 480,
          background: "var(--cream)",
          display: "flex", flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 320ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        {/* Header */}
        <div style={{ padding: "24px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--hairline)" }}>
          <div>
            <div className="eyebrow">Your bag</div>
            <div className="serif" style={{ fontSize: 22, marginTop: 4 }}>{items.length} {items.length === 1 ? "item" : "items"}</div>
          </div>
          <button onClick={onClose} aria-label="Close">{Icon.close}</button>
        </div>

        {/* Free shipping progress */}
        {items.length > 0 && (
          <div style={{ padding: "16px 28px", borderBottom: "1px solid var(--hairline)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 8 }}>
              <span style={{ color: "var(--warm-grey)" }}>
                {subtotal >= 2499 ? "🎉 Free shipping unlocked" : `Add ₹${(2499 - subtotal).toLocaleString("en-IN")} for free shipping`}
              </span>
              <span className="tnum" style={{ color: "var(--charcoal)" }}>₹{subtotal.toLocaleString("en-IN")} / ₹2,499</span>
            </div>
            <div style={{ height: 3, background: "var(--cream-2)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, (subtotal / 2499) * 100)}%`, background: "var(--terracotta)", transition: "width 320ms" }} />
            </div>
          </div>
        )}

        {/* Items */}
        <div className="subtle-scroll" style={{ flex: 1, overflowY: "auto", padding: "8px 28px" }}>
          {items.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 20px" }}>
              <div className="serif" style={{ fontSize: 60, color: "var(--terracotta)", lineHeight: 1 }}>“</div>
              <h3 className="h2" style={{ margin: "16px 0 8px" }}>Your bag is empty.</h3>
              <p style={{ color: "var(--warm-grey)", fontSize: 14 }}>Wander into the kurta sets — we just dropped Saanjh.</p>
              <button onClick={onClose} className="btn btn-primary" style={{ marginTop: 24 }}>Continue shopping</button>
            </div>
          ) : (
            items.map((it, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 16, padding: "20px 0", borderBottom: "1px solid var(--hairline)" }}>
                <div style={{ width: 80, height: 100 }}>
                  <FabricSwatch
                    name={it.name}
                    gsm={it.fabric.gsm}
                    color={it.colorHex}
                    colorName={it.color}
                    weave={it.fabric.weaveKey}
                    aspect="auto"
                    size="sm"
                    showMeta={false}
                    withCorners={false}
                  />
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <div className="serif" style={{ fontSize: 16 }}>{it.fullName}</div>
                    <button onClick={() => removeItem(idx)} style={{ color: "var(--muted)", fontSize: 11 }}>Remove</button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>{it.color} · Size {it.size}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--hairline-2)" }}>
                      <button onClick={() => updateQty(idx, Math.max(1, it.qty - 1))} style={{ width: 28, height: 28, fontSize: 14 }}>−</button>
                      <span className="tnum" style={{ width: 24, textAlign: "center", fontSize: 13 }}>{it.qty}</span>
                      <button onClick={() => updateQty(idx, it.qty + 1)} style={{ width: 28, height: 28, fontSize: 14 }}>+</button>
                    </div>
                    <span className="tnum" style={{ fontWeight: 500 }}>₹{(it.price * it.qty).toLocaleString("en-IN")}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div style={{ padding: 28, borderTop: "1px solid var(--hairline)", background: "var(--ivory)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--warm-grey)", marginBottom: 8 }}>
              <span>Subtotal</span>
              <span className="tnum">₹{subtotal.toLocaleString("en-IN")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--warm-grey)", marginBottom: 12 }}>
              <span>Shipping</span>
              <span className="tnum">{shipping === 0 ? "Free" : `₹${shipping}`}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingTop: 12, borderTop: "1px solid var(--hairline)" }}>
              <span className="serif" style={{ fontSize: 18 }}>Total</span>
              <span className="serif tnum" style={{ fontSize: 22, fontWeight: 500 }}>₹{total.toLocaleString("en-IN")}</span>
            </div>
            <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 16 }}>Checkout — Pay ₹{total.toLocaleString("en-IN")}</button>
            <p style={{ marginTop: 12, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>Secure checkout · COD available · Easy exchange</p>
          </div>
        )}
      </div>
    </div>
  );
};

// ------- Size Guide Modal -------
const SizeGuide = ({ open, onClose }) => {
  const [unit, setUnit] = useDrawerState("in");
  const [system, setSystem] = useDrawerState("india");
  const { SIZE_CHART } = window.TAPI_DATA;

  useDrawerEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  const inToCm = (v) => Math.round(parseFloat(v) * 2.54);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(44,40,38,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--cream)", maxWidth: 720, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 0 }}>
        <div style={{ padding: "28px 32px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--hairline)", position: "sticky", top: 0, background: "var(--cream)" }}>
          <div>
            <div className="eyebrow">Size guide</div>
            <h2 className="h1" style={{ margin: "4px 0 0", fontSize: 28 }}>Find your fit</h2>
          </div>
          <button onClick={onClose}>{Icon.close}</button>
        </div>

        <div style={{ padding: 32 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--hairline)" }}>
            {["india", "international"].map((t) => (
              <button key={t} onClick={() => setSystem(t)} style={{ padding: "12px 16px", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: system === t ? "2px solid var(--charcoal)" : "2px solid transparent", color: system === t ? "var(--charcoal)" : "var(--warm-grey)" }}>
                {t === "india" ? "India · letter" : "International"}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", border: "1px solid var(--hairline-2)" }}>
              {["in", "cm"].map((u) => (
                <button key={u} onClick={() => setUnit(u)} style={{ padding: "6px 12px", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", background: unit === u ? "var(--charcoal)" : "transparent", color: unit === u ? "var(--cream)" : "var(--charcoal)" }}>{u}</button>
              ))}
            </div>
          </div>

          {/* Chart */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} className="tnum">
            <thead>
              <tr>
                {SIZE_CHART.headers.map((h, i) => (
                  <th key={h} style={{ textAlign: i === 0 ? "left" : "center", padding: "12px 8px", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)", borderBottom: "1px solid var(--hairline-2)" }}>{h.replace("(in)", `(${unit})`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SIZE_CHART.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ padding: "14px 8px", textAlign: ci === 0 ? "left" : "center", borderBottom: "1px dashed var(--hairline)", fontFamily: ci === 0 ? "var(--font-serif)" : "inherit", fontSize: ci === 0 ? 16 : 13, color: ci === 0 ? "var(--charcoal)" : "var(--warm-grey)" }}>
                      {ci === 0 ? cell : (unit === "in" ? cell : inToCm(cell))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {/* How to measure */}
          <div style={{ marginTop: 40 }}>
            <h3 className="serif" style={{ fontSize: 20, marginBottom: 16 }}>How to measure</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }} className="how-grid">
              {[
                { t: "Bust", b: "Measure around the fullest part of your bust, keeping the tape relaxed and parallel to the floor." },
                { t: "Waist", b: "Measure around your natural waistline — the narrowest part, usually above the belly button." },
                { t: "Hip", b: "Measure around the fullest part of your hips, about 8\" below your natural waist." },
              ].map((row) => (
                <div key={row.t}>
                  <div style={{ fontFamily: "var(--font-serif)", fontSize: 17, marginBottom: 6 }}>{row.t}</div>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--warm-grey)", lineHeight: 1.6 }}>{row.b}</p>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 24, padding: 16, background: "var(--terracotta-wash)", fontSize: 13, color: "var(--terracotta-deep)", margin: "24px 0 0" }}>
              <strong style={{ fontWeight: 600 }}>Honest tip:</strong> if you're between sizes and prefer a relaxed fit (the way most of our kurtas are styled), size up. 78% of our buyers say our pieces run true to size — the other 22% mostly recommend sizing up.
            </p>
          </div>
        </div>

        <style>{`
          @media (max-width: 600px) {
            .how-grid { grid-template-columns: 1fr !important; }
          }
        `}</style>
      </div>
    </div>
  );
};

window.CartDrawer = CartDrawer;
window.SizeGuide = SizeGuide;
