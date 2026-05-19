/* global React */
// Four logo variations for Tapi & Co. — pick one (or mix).

// ---------------- 01 · Ripple Mark + Wordmark ----------------
const Logo01 = ({ scale = 1 }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 14 * scale, color: "#2C2826", lineHeight: 1 }}>
    <svg width={44 * scale} height={44 * scale} viewBox="0 0 44 44" fill="none">
      <circle cx="22" cy="22" r="21" stroke="#2C2826" strokeWidth="1" />
      <path d="M9 18 C 14 14, 18 22, 22 18 S 30 14, 35 18" stroke="#2C2826" strokeWidth="1.1" fill="none" strokeLinecap="round"/>
      <path d="M9 23 C 14 19, 18 27, 22 23 S 30 19, 35 23" stroke="#2C2826" strokeWidth="1.1" fill="none" strokeLinecap="round"/>
      <path d="M9 28 C 14 24, 18 32, 22 28 S 30 24, 35 28" stroke="#2C2826" strokeWidth="1.1" fill="none" strokeLinecap="round"/>
    </svg>
    <span style={{ fontFamily: "var(--font-serif)", fontSize: 36 * scale, fontWeight: 500, letterSpacing: "-0.01em" }}>
      Tapi
      <span style={{ fontStyle: "italic", padding: "0 0.05em", fontWeight: 400 }}> & </span>
      Co.
    </span>
  </div>
);

// ---------------- 02 · Editorial Wordmark only ----------------
const Logo02 = ({ scale = 1 }) => (
  <div style={{ textAlign: "center", color: "#2C2826", lineHeight: 1 }}>
    <div style={{ fontFamily: "var(--font-serif)", fontSize: 64 * scale, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 0.95 }}>
      Tapi <span style={{ fontStyle: "italic", fontWeight: 400 }}>&amp;</span> Co.
    </div>
    <div style={{ marginTop: 12 * scale, fontFamily: "var(--font-sans)", fontSize: 10 * scale, letterSpacing: "0.4em", textTransform: "uppercase", color: "#6b5d54" }}>
      — Surat · est. 2025 —
    </div>
  </div>
);

// ---------------- 03 · Circular monogram seal ----------------
const Logo03 = ({ scale = 1 }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: 18 * scale, color: "#2C2826", lineHeight: 1 }}>
    <svg width={84 * scale} height={84 * scale} viewBox="0 0 84 84">
      <circle cx="42" cy="42" r="41" fill="none" stroke="#2C2826" strokeWidth="1" />
      <circle cx="42" cy="42" r="36" fill="none" stroke="#2C2826" strokeWidth="0.6" strokeDasharray="2 4" />
      {/* Curved text along top */}
      <defs>
        <path id="ttop" d="M 14 42 A 28 28 0 0 1 70 42" fill="none" />
        <path id="tbot" d="M 70 42 A 28 28 0 0 1 14 42" fill="none" />
      </defs>
      <text fill="#6b5d54" style={{ fontFamily: "var(--font-sans)", fontSize: 6, letterSpacing: "0.3em" }}>
        <textPath href="#ttop" startOffset="50%" textAnchor="middle">— MADE IN SURAT —</textPath>
      </text>
      <text fill="#6b5d54" style={{ fontFamily: "var(--font-sans)", fontSize: 6, letterSpacing: "0.3em" }}>
        <textPath href="#tbot" startOffset="50%" textAnchor="middle">EST. 2025 · TAPI</textPath>
      </text>
      {/* Monogram T&C */}
      <text x="42" y="48" textAnchor="middle" fill="#B7472A" style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 500 }}>
        T<tspan fontStyle="italic" fontSize="16" dy="-1" fill="#2C2826">&amp;</tspan>C
      </text>
    </svg>
    <div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 30 * scale, fontWeight: 500, letterSpacing: "-0.012em" }}>
        Tapi <span style={{ fontStyle: "italic", fontWeight: 400 }}>&amp;</span> Co.
      </div>
      <div style={{ marginTop: 6 * scale, fontFamily: "var(--font-sans)", fontSize: 9 * scale, letterSpacing: "0.3em", textTransform: "uppercase", color: "#6b5d54" }}>
        Wearable studies in fabric
      </div>
    </div>
  </div>
);

// ---------------- 04 · Stacked Loom Mark ----------------
const Logo04 = ({ scale = 1 }) => (
  <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 12 * scale, color: "#2C2826", lineHeight: 1 }}>
    {/* Mark: stylised loom — two warp lines, weft */}
    <svg width={52 * scale} height={52 * scale} viewBox="0 0 52 52">
      {/* Vertical warps */}
      <line x1="10" y1="6" x2="10" y2="46" stroke="#2C2826" strokeWidth="1" />
      <line x1="20" y1="6" x2="20" y2="46" stroke="#2C2826" strokeWidth="1" />
      <line x1="32" y1="6" x2="32" y2="46" stroke="#2C2826" strokeWidth="1" />
      <line x1="42" y1="6" x2="42" y2="46" stroke="#2C2826" strokeWidth="1" />
      {/* Horizontal weft passes — terracotta accent */}
      <line x1="6" y1="14" x2="46" y2="14" stroke="#B7472A" strokeWidth="1.4" />
      <line x1="6" y1="22" x2="46" y2="22" stroke="#2C2826" strokeWidth="1" />
      <line x1="6" y1="30" x2="46" y2="30" stroke="#B7472A" strokeWidth="1.4" />
      <line x1="6" y1="38" x2="46" y2="38" stroke="#2C2826" strokeWidth="1" />
    </svg>
    <div style={{ fontFamily: "var(--font-serif)", fontSize: 28 * scale, fontWeight: 500, letterSpacing: "-0.012em" }}>
      Tapi <span style={{ fontStyle: "italic", fontWeight: 400 }}>&amp;</span> Co.
    </div>
    <div style={{ marginTop: 4 * scale, fontFamily: "var(--font-sans)", fontSize: 9 * scale, letterSpacing: "0.32em", textTransform: "uppercase", color: "#6b5d54" }}>
      Mid-premium · Surat
    </div>
  </div>
);

// ---------------- Artboard wrapper ----------------
const LogoArt = ({ label, children, bg = "#F8F4ED", inv = false, notes }) => {
  const tx = inv ? "#F8F4ED" : "#2C2826";
  return (
    <div style={{
      background: bg, color: tx,
      width: 720, height: 480,
      display: "flex", flexDirection: "column",
      padding: 32, position: "relative",
      border: "1px solid rgba(44,40,38,0.08)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", opacity: 0.6 }}>
        <span>{label}</span>
        <span>Tapi &amp; Co. · Logo studies</span>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
      {notes && (
        <div style={{ fontSize: 11, letterSpacing: "0.04em", color: inv ? "rgba(248,244,237,0.7)" : "rgba(44,40,38,0.65)", lineHeight: 1.6, fontStyle: "italic", fontFamily: "var(--font-serif)" }}>
          {notes}
        </div>
      )}
    </div>
  );
};

// Smaller "in use" artboard
const LogoUseArt = ({ label, children, bg = "#F8F4ED", inv = false }) => {
  const tx = inv ? "#F8F4ED" : "#2C2826";
  return (
    <div style={{ background: bg, color: tx, width: 360, height: 240, padding: 24, display: "flex", flexDirection: "column", border: "1px solid rgba(44,40,38,0.08)" }}>
      <div style={{ fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase", opacity: 0.6, marginBottom: 16 }}>{label}</div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
    </div>
  );
};

const LogoCanvas = () => {
  return (
    <window.DesignCanvas title="Tapi & Co. · Logo directions" subtitle="Four directions — pick one or tell me which to refine.">
      <window.DCSection id="directions" title="Four logo directions">
        <window.DCArtboard id="dir-01" label="01 · Ripple mark + wordmark" width={720} height={480}>
          <LogoArt label="01 · Ripple mark + wordmark" notes="The Tapi-river ripple, three flowing curves inside a circle. Editorial serif paired with italic ampersand. Most balanced, works at favicon size.">
            <Logo01 scale={1} />
          </LogoArt>
        </window.DCArtboard>

        <window.DCArtboard id="dir-02" label="02 · Editorial wordmark only" width={720} height={480}>
          <LogoArt label="02 · Editorial wordmark only" notes="No mark. Just the name set big and confident, like a magazine masthead. Cleanest for header use; least distinctive without context.">
            <Logo02 scale={1} />
          </LogoArt>
        </window.DCArtboard>

        <window.DCArtboard id="dir-03" label="03 · Circular monogram seal" width={720} height={480}>
          <LogoArt label="03 · Circular monogram seal" notes="Heritage seal feel — circular text border around a T&C monogram. Most distinctive at scale. Great on hangtags, packaging stamps.">
            <Logo03 scale={1} />
          </LogoArt>
        </window.DCArtboard>

        <window.DCArtboard id="dir-04" label="04 · Stacked loom mark" width={720} height={480}>
          <LogoArt label="04 · Stacked loom mark" notes="A literal loom diagram — warps and wefts, terracotta accents woven through. Most on-brand for a Surat textile studio. Stacked layout works in square avatars.">
            <Logo04 scale={1} />
          </LogoArt>
        </window.DCArtboard>
      </window.DCSection>

      <window.DCSection id="in-use" title="In use — how the chosen direction looks in context">
        <window.DCArtboard id="use-01-light" label="01 · Header (light)" width={360} height={240}>
          <LogoUseArt label="Header">
            <div style={{ transform: "scale(0.55)" }}><Logo01 /></div>
          </LogoUseArt>
        </window.DCArtboard>
        <window.DCArtboard id="use-01-dark" label="01 · Footer (dark)" width={360} height={240}>
          <LogoUseArt label="Footer · charcoal" bg="#2C2826" inv>
            <div style={{ filter: "invert(1)", transform: "scale(0.55)" }}><Logo01 /></div>
          </LogoUseArt>
        </window.DCArtboard>
        <window.DCArtboard id="use-01-favicon" label="01 · Favicon" width={360} height={240}>
          <LogoUseArt label="Favicon · 32×32">
            <svg width="96" height="96" viewBox="0 0 44 44">
              <circle cx="22" cy="22" r="21" stroke="#2C2826" strokeWidth="1" fill="#F8F4ED"/>
              <path d="M9 18 C 14 14, 18 22, 22 18 S 30 14, 35 18" stroke="#B7472A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
              <path d="M9 23 C 14 19, 18 27, 22 23 S 30 19, 35 23" stroke="#2C2826" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
              <path d="M9 28 C 14 24, 18 32, 22 28 S 30 24, 35 28" stroke="#B7472A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
            </svg>
          </LogoUseArt>
        </window.DCArtboard>
        <window.DCArtboard id="use-01-stamp" label="01 · Hangtag stamp" width={360} height={240}>
          <LogoUseArt label="Hangtag · cream card" bg="#F1EBDD">
            <div style={{ border: "1px dashed #2C2826", padding: 16, transform: "scale(0.6)" }}>
              <Logo01 />
              <div style={{ marginTop: 8, fontSize: 10, letterSpacing: "0.18em", textAlign: "center", textTransform: "uppercase", color: "#6b5d54" }}>
                Drop 01 · Saanjh · ₹2,890
              </div>
            </div>
          </LogoUseArt>
        </window.DCArtboard>
      </window.DCSection>
    </window.DesignCanvas>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<LogoCanvas />);
