/* global React, ReactDOM */
// Three PDP directions, lo-fi but legible, side-by-side.
// Each artboard shows the *buy column* at scale; the user picks a direction.

const swatch = (color, weave, w = 400, h = 500) => {
  const dim = (a) => {
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  };
  const patterns = {
    plain: `repeating-linear-gradient(90deg, ${dim(0.08)} 0 1px, transparent 1px 4px), repeating-linear-gradient(0deg, ${dim(0.08)} 0 1px, transparent 1px 4px)`,
    twill: `repeating-linear-gradient(45deg, ${dim(0.10)} 0 2px, transparent 2px 6px)`,
    dobby: `radial-gradient(circle at 50% 50%, ${dim(0.22)} 1.5px, transparent 2.5px) 0 0 / 10px 10px`,
  };
  return { background: `${patterns[weave]}, linear-gradient(135deg, ${dim(0.08)}, ${dim(0.18)}), #F1EBDD`, width: w, height: h };
};

// ---------- Direction A · Classic editorial ----------
const PdpA = () => (
  <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 32, padding: 40, background: "#F8F4ED", fontFamily: "var(--font-sans)", color: "#2C2826" }}>
    <div>
      <div style={{ ...swatch("#B7472A", "plain", "100%", 560), aspectRatio: "3/4" }} />
      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        {[0,1,2,3,4].map(i => <div key={i} style={{ ...swatch("#B7472A", "plain", 56, 70), border: i === 0 ? "1px solid #2C2826" : "1px solid #D6CDB8" }} />)}
      </div>
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#9a8d83" }}>Kurta Sets · New</span>
      <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 36, margin: 0, fontWeight: 500, lineHeight: 1.05 }}>Saanjh Kurta Set</h1>
      <p style={{ margin: 0, fontSize: 14, color: "#6b5d54" }}>Mulmul cotton · 3-piece</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 12, borderBottom: "1px solid #E5DDC8" }}>
        <span style={{ color: "#B7472A", fontSize: 14 }}>★★★★★</span>
        <span style={{ fontSize: 12 }}>4.7 · 142 reviews</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 28, fontWeight: 500 }}>₹2,890</span>
        <span style={{ fontSize: 14, color: "#9a8d83", textDecoration: "line-through" }}>₹3,400</span>
      </div>
      <div>
        <div style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>Color · Terracotta</div>
        <div style={{ display: "flex", gap: 8 }}>
          {["#B7472A","#7A8761","#E8DDC4"].map((c, i) => <span key={c} style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: i === 0 ? "1.5px solid #2C2826" : "1px solid #D6CDB8" }} />)}
        </div>
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>
          <span>Size</span><span>Size guide →</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["XS","S","M","L","XL"].map((s, i) => <span key={s} style={{ width: 44, height: 40, border: i === 1 ? "1px solid #2C2826" : "1px solid #D6CDB8", background: i === 1 ? "#2C2826" : "transparent", color: i === 1 ? "#F8F4ED" : "#2C2826", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{s}</span>)}
        </div>
      </div>
      <button style={{ height: 52, background: "#2C2826", color: "#F8F4ED", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 8, border: "none" }}>Add to bag — ₹2,890</button>
      <button style={{ height: 52, background: "#B7472A", color: "#F8F4ED", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", border: "none" }}>Buy it now</button>
    </div>
  </div>
);

// ---------- Direction B · Storyteller / long-scroll ----------
const PdpB = () => (
  <div style={{ background: "#F8F4ED", color: "#2C2826" }}>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, padding: 40 }}>
      <div style={{ ...swatch("#7A8761", "twill", "100%", 600), aspectRatio: "1/1.3", position: "relative" }}>
        <div style={{ position: "absolute", bottom: 16, left: 16, right: 16, fontFamily: "var(--font-serif)", fontSize: 11, fontStyle: "italic", color: "#6b5d54" }}>
          Worn by Anya · 5'7" · Size S
        </div>
      </div>
      <div style={{ position: "sticky", top: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 48, margin: 0, fontStyle: "italic", fontWeight: 400, lineHeight: 1 }}>Roohi.</h1>
        <p style={{ fontFamily: "var(--font-serif)", fontSize: 18, margin: 0, lineHeight: 1.5, color: "#3a3431" }}>A 3-piece that earns its place in your everyday. Cotton-modal, wide-leg, soft drape.</p>
        <div style={{ display: "flex", gap: 12, paddingTop: 12, marginTop: 4, borderTop: "1px solid #E5DDC8", borderBottom: "1px solid #E5DDC8", padding: "16px 0" }}>
          <div style={{ flex: 1 }}><div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#9a8d83" }}>GSM</div><div style={{ fontFamily: "var(--font-serif)", fontSize: 22 }}>145</div></div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#9a8d83" }}>WEAVE</div><div style={{ fontFamily: "var(--font-serif)", fontSize: 16, fontStyle: "italic" }}>Satin</div></div>
          <div style={{ flex: 1 }}><div style={{ fontSize: 9, letterSpacing: "0.18em", color: "#9a8d83" }}>BLEND</div><div style={{ fontFamily: "var(--font-serif)", fontSize: 16, fontStyle: "italic" }}>70/30 cotton</div></div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {["#7A8761","#6B2F3D"].map((c, i) => <span key={c} style={{ width: 32, height: 32, borderRadius: "50%", background: c, border: i === 0 ? "1.5px solid #2C2826" : "1px solid #D6CDB8" }} />)}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["XS","S","M","L","XL","XXL"].map((s, i) => <span key={s} style={{ width: 40, height: 40, border: "1px solid " + (i === 2 ? "#2C2826" : "#D6CDB8"), background: i === 2 ? "#2C2826" : "transparent", color: i === 2 ? "#F8F4ED" : "#2C2826", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>{s}</span>)}
        </div>
        <button style={{ height: 56, background: "#B7472A", color: "#F8F4ED", border: "none", fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 8 }}>
          ₹3,490 — Add to bag
        </button>
        <div style={{ fontSize: 11, color: "#6b5d54", fontStyle: "italic", marginTop: 4 }}>
          85% of buyers say it runs true to size.
        </div>
      </div>
    </div>
    {/* Editorial story strip */}
    <div style={{ padding: "32px 40px", borderTop: "1px solid #E5DDC8", background: "#F1EBDD" }}>
      <div style={{ fontSize: 9, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>The story of this piece</div>
      <p style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontStyle: "italic", margin: 0, color: "#3a3431", lineHeight: 1.4 }}>
        "We took seventeen swatches to lock the blend. The drape is the difference."
      </p>
    </div>
  </div>
);

// ---------- Direction C · Specsheet / fabric-first ----------
const PdpC = () => (
  <div style={{ background: "#F8F4ED", color: "#2C2826", padding: 40 }}>
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 24 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 56 }}>
        {[0,1,2,3].map(i => <div key={i} style={{ ...swatch("#B08947", "dobby", 56, 70), border: i === 0 ? "1px solid #2C2826" : "1px solid #D6CDB8" }} />)}
      </div>
      <div style={{ ...swatch("#B08947", "dobby", "100%", 560), aspectRatio: "3/4" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#9a8d83" }}>Festive · Sku TPI-MEH-001</span>
          <span style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#B7472A" }}>Festive</span>
        </div>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: 30, margin: 0, fontWeight: 500, lineHeight: 1.05 }}>Mehfil Kurta Set</h1>
        <p style={{ margin: 0, fontSize: 13, color: "#6b5d54" }}>₹4,290 · Silk-cotton dobby</p>

        {/* Spec table */}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
          <tbody>
            {[
              ["GSM","180"],
              ["Blend","Silk-cotton"],
              ["Weave","Dobby"],
              ["Fit","Regular"],
              ["Opacity","Opaque"],
              ["Care","Dry clean"],
            ].map(([k,v]) => (
              <tr key={k} style={{ borderBottom: "1px dashed #D6CDB8" }}>
                <td style={{ padding: "8px 0", color: "#9a8d83", letterSpacing: "0.06em", width: "45%", fontSize: 10, textTransform: "uppercase" }}>{k}</td>
                <td style={{ padding: "8px 0", fontFamily: "var(--font-serif)", fontSize: 14 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {["XS","S","M","L","XL","XXL"].map((s, i) => <span key={s} style={{ width: 36, height: 36, border: "1px solid " + (i === 1 ? "#2C2826" : "#D6CDB8"), background: i === 1 ? "#2C2826" : "transparent", color: i === 1 ? "#F8F4ED" : "#2C2826", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{s}</span>)}
        </div>

        <button style={{ height: 48, background: "#2C2826", color: "#F8F4ED", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", border: "none" }}>
          Add to bag
        </button>
      </div>
    </div>
  </div>
);

// ---------- Canvas ----------
const PdpCanvas = () => (
  <window.DesignCanvas
    title="Tapi & Co. · PDP directions"
    subtitle="Three directions for the product page. Each one is the same product styled differently."
  >
    <window.DCSection id="pdp-options" title="Three PDP directions">
      <window.DCArtboard id="pdp-a" label="A · Classic editorial" width={1100} height={720}>
        <div style={{ width: 1100, height: 720, overflow: "hidden" }}><PdpA /></div>
      </window.DCArtboard>
      <window.DCArtboard id="pdp-b" label="B · Storyteller (long-scroll, narrative)" width={1100} height={820}>
        <div style={{ width: 1100, height: 820, overflow: "hidden" }}><PdpB /></div>
      </window.DCArtboard>
      <window.DCArtboard id="pdp-c" label="C · Specsheet (fabric-first, dense)" width={1100} height={720}>
        <div style={{ width: 1100, height: 720, overflow: "hidden" }}><PdpC /></div>
      </window.DCArtboard>
    </window.DCSection>

    <window.DCSection id="notes" title="Notes — what each direction emphasises">
      <window.DCArtboard id="note-a" label="A · Classic editorial" width={420} height={300}>
        <div style={{ padding: 28, background: "#F8F4ED", height: "100%", color: "#2C2826", fontFamily: "var(--font-sans)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>Direction A</div>
          <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: "0 0 12px", fontWeight: 500 }}>Classic editorial</h3>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13, color: "#3a3431" }}>
            <li>Industry-standard PDP layout — left gallery, right buy column</li>
            <li>Fast scan, conversion-optimised</li>
            <li>Pairs cleanly with our editorial brand voice</li>
            <li>Safe, expected, performant <em>— recommended default</em></li>
          </ul>
        </div>
      </window.DCArtboard>
      <window.DCArtboard id="note-b" label="B · Storyteller" width={420} height={300}>
        <div style={{ padding: 28, background: "#F8F4ED", height: "100%", color: "#2C2826", fontFamily: "var(--font-sans)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>Direction B</div>
          <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: "0 0 12px", fontWeight: 500 }}>Storyteller</h3>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13, color: "#3a3431" }}>
            <li>Long-scroll, narrative product page</li>
            <li>Italic display name + quote from the studio</li>
            <li>Best for hero pieces / drop launches</li>
            <li>Trade-off: more scroll-depth to add to cart</li>
          </ul>
        </div>
      </window.DCArtboard>
      <window.DCArtboard id="note-c" label="C · Specsheet" width={420} height={300}>
        <div style={{ padding: 28, background: "#F8F4ED", height: "100%", color: "#2C2826", fontFamily: "var(--font-sans)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", color: "#6b5d54", marginBottom: 8 }}>Direction C</div>
          <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, margin: "0 0 12px", fontWeight: 500 }}>Specsheet</h3>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontSize: 13, color: "#3a3431" }}>
            <li>Fabric data table above the fold</li>
            <li>For repeat / informed buyers who know GSM matters</li>
            <li>Heroes the "honest in numbers" brand promise</li>
            <li>Risk: dense, may overwhelm first-time visitors</li>
          </ul>
        </div>
      </window.DCArtboard>
    </window.DCSection>
  </window.DesignCanvas>
);

ReactDOM.createRoot(document.getElementById("root")).render(<PdpCanvas />);
