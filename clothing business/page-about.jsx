/* global React, Icon, FabricSwatch */

const AboutPage = ({ navigate }) => {
  return (
    <main>
      {/* Hero */}
      <section style={{ padding: "clamp(48px, 8vw, 80px) 0 clamp(64px, 10vw, 120px)" }}>
        <div className="container">
          <div className="about-hero" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "clamp(32px, 6vw, 80px)", alignItems: "center" }}>
            <div>
              <span className="eyebrow">— Our story · est. 2024, Surat</span>
              <h1 className="display-xl" style={{ margin: "16px 0 0" }}>
                A studio above<br/>
                <em style={{ color: "var(--terracotta)", fontWeight: 500 }}>my father's shop.</em>
              </h1>
              <p className="lede" style={{ marginTop: 24, maxWidth: 520 }}>
                I'm Aanya. My husband Vikrant and I started Tapi &amp; Co. in a single room in Rampura, Surat. Today the cousins help with operations, the studio is bigger, and the fabric still comes from eleven weavers within walking distance.
              </p>
            </div>
            <div>
              <FabricSwatch
                name="Tapi"
                gsm={120}
                color="#B7472A"
                colorName="The river"
                weave="plain"
                aspect="4/5"
                size="lg"
              />
            </div>
          </div>
        </div>
      </section>

      {/* The name */}
      <section style={{ background: "var(--cream-2)", padding: "clamp(56px, 9vw, 96px) 0" }}>
        <div className="container">
          <div className="abt-name" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "clamp(32px, 5vw, 64px)", alignItems: "center" }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 12 }}>The name</div>
              <h2 className="display-lg" style={{ margin: 0 }}>Tapi is the river<br/>that runs through us.</h2>
            </div>
            <p style={{ fontSize: 16, lineHeight: 1.8, margin: 0, color: "var(--warm-grey)" }}>
              The Tapi flows past Surat into the Arabian Sea. Our city has been a textile port for four centuries — its handlooms once dressed half the world. We took her name because we wanted our label to feel like it belonged here, not anywhere else.
            </p>
          </div>
        </div>
      </section>

      {/* Principles */}
      <section className="section">
        <div className="container">
          <div className="eyebrow" style={{ marginBottom: 12 }}>How we work</div>
          <h2 className="display-lg" style={{ margin: 0, marginBottom: "clamp(32px, 5vw, 56px)" }}>Three principles, nothing else.</h2>

          <div className="principles" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "clamp(20px, 3vw, 32px)" }}>
            {[
              {
                n: "01",
                t: "Tell the truth in numbers",
                b: "GSM, blend, weave, fit-type, opacity, model's measurements. On every product page. If you'd ask us in person, it should be written down.",
              },
              {
                n: "02",
                t: "Size-true, always",
                b: "Our chart is built from the bodies of our family, friends, and customers — not industry standards. We list fit feedback from real buyers below every size selector.",
              },
              {
                n: "03",
                t: "Show what arrives",
                b: "No filters, no stretched models, no posed photography that disagrees with the garment. What you see on screen is what comes out of the box.",
              },
            ].map((p) => (
              <div key={p.n} style={{ padding: "clamp(20px, 3vw, 32px)", border: "1px solid var(--hairline)", background: "var(--ivory)" }}>
                <div className="serif tnum" style={{ fontSize: 48, color: "var(--terracotta)", fontWeight: 500, lineHeight: 1 }}>{p.n}</div>
                <h3 className="serif" style={{ fontSize: 24, margin: "16px 0 12px", fontWeight: 500 }}>{p.t}</h3>
                <p style={{ margin: 0, color: "var(--warm-grey)", fontSize: 14, lineHeight: 1.7 }}>{p.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Timeline */}
      <section style={{ background: "var(--charcoal)", color: "var(--cream)", padding: "clamp(64px, 10vw, 120px) 0" }}>
        <div className="container">
          <div className="eyebrow" style={{ color: "var(--terracotta-soft)", marginBottom: 12 }}>The arc</div>
          <h2 className="display-lg" style={{ margin: 0, color: "var(--cream)", marginBottom: "clamp(36px, 6vw, 64px)" }}>How we got here.</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              { y: "2023", t: "Two ideas and a sewing table", b: "Vikrant resigns from his job. We start with five pieces sewn at our kitchen table." },
              { y: "Jul 2024", t: "The Rampura studio", b: "A single room above father's shop. Three karigars. Our first WhatsApp orders." },
              { y: "Oct 2024", t: "First drop on Instagram", b: "Saanjh kurta sets sell out in 36 hours. Cousins join operations." },
              { y: "Mar 2025", t: "Cotton-modal blend perfected", b: "After seventeen swatches, we lock the cotton-modal blend for Roohi." },
              { y: "Today", t: "Studio expansion, online launch", b: "Eleven weavers within walking distance. This website. Hello." },
            ].map((row, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 32, padding: "28px 0", borderTop: "1px solid rgba(248,244,237,0.12)" }}>
                <div className="serif tnum" style={{ fontSize: 22, color: "var(--terracotta-soft)" }}>{row.y}</div>
                <div>
                  <div className="serif" style={{ fontSize: 22, marginBottom: 6 }}>{row.t}</div>
                  <div style={{ color: "var(--cream)", opacity: 0.7, fontSize: 14, lineHeight: 1.65, maxWidth: 600 }}>{row.b}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pickup CTA */}
      <section className="section">
        <div className="container">
          <div style={{ padding: "clamp(28px, 5vw, 56px)", background: "var(--terracotta-wash)", display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: "clamp(28px, 4vw, 48px)", alignItems: "center" }} className="abt-pickup">
            <div>
              <div className="eyebrow" style={{ marginBottom: 12, color: "var(--terracotta-deep)" }}>If you're in Surat</div>
              <h2 className="display-lg" style={{ margin: 0 }}>Come pick up<br/>from the studio.</h2>
              <p className="lede" style={{ marginTop: 16, maxWidth: 480 }}>
                We host pickup on weekdays from 10am–7pm. Save ₹50, see the fabric in person, drink tea, leave with your order in a hand-stamped cloth bag.
              </p>
              <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
                <button className="btn btn-primary">Plan a visit</button>
                <button className="btn btn-outline">{Icon.whatsapp} &nbsp;Message us</button>
              </div>
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.9, fontFamily: "var(--font-serif)" }}>
              <strong style={{ fontWeight: 500 }}>Tapi &amp; Co. studio</strong><br/>
              Rampura Main Rd, 2nd floor<br/>
              Surat 395003, Gujarat<br/>
              <br/>
              Mon–Sat · 10am–7pm<br/>
              Closed on Sundays
            </div>
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 900px) {
          .about-hero, .abt-name, .principles, .abt-pickup { grid-template-columns: 1fr !important; gap: 32px !important; }
        }
      `}</style>
    </main>
  );
};

window.AboutPage = AboutPage;
