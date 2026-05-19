/* global React, Icon, ProductCard, FabricSwatch */
// Homepage

const HomePage = ({ navigate, openProduct }) => {
  const { PRODUCTS, COLLECTIONS } = window.TAPI_DATA;
  const { Reveal, Stagger, CountUp, Magnetic, RevealText } = window;

  return (
    <main>
      {/* HERO */}
      <section style={{ paddingTop: "clamp(24px, 4vw, 48px)", paddingBottom: "clamp(48px, 8vw, 96px)" }}>
        <div className="container">
          <div className="hero-grid" style={{ display: "grid", gridTemplateColumns: "1.05fr 1.4fr", gap: "clamp(28px, 4vw, 56px)", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "clamp(18px, 2.4vw, 28px)" }}>
              <span className="eyebrow eyebrow-line tapi-rise" style={{ animationDelay: "60ms" }}>Drop 01 · Saanjh, the dusk edit</span>
              <h1 className="display-xl" style={{ margin: 0 }} data-comment-anchor="cc-1">
                <span className="tapi-rise" style={{ display: "inline-block", animationDelay: "120ms" }}>Woven by eleven hands.</span><br/>
                <em className="tapi-rise" style={{ color: "var(--terracotta)", fontWeight: 500, display: "inline-block", animationDelay: "260ms" }}>Worn by yours.</em>
              </h1>
              <p className="lede tapi-rise" style={{ maxWidth: 460, animationDelay: "400ms" }}>
                A small family in Surat — making ethnic wear the way we'd want to receive it ourselves.
                We'll tell you the weight, the weave, the fit. And what arrives, is exactly what you see.
              </p>
              <div className="tapi-rise" style={{ display: "flex", gap: 12, flexWrap: "wrap", animationDelay: "520ms" }}>
                <Magnetic strength={0.12}><button onClick={() => navigate({ name: "collection", slug: "kurta-sets" })} className="btn btn-primary btn-lg tapi-arrow-slide">
                  Shop kurta sets {Icon.arrowRight}
                </button></Magnetic>
                <button onClick={() => navigate({ name: "about" })} className="btn btn-outline btn-lg">Our story</button>
              </div>
              <div className="tapi-rise" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 16, paddingTop: 28, borderTop: "1px solid var(--hairline)", animationDelay: "640ms" }}>
                {[
                  { k: "Size", v: "True to body" },
                  { k: "Fabric", v: "120–180 GSM listed" },
                  { k: "Made in", v: "Surat, Gujarat" },
                ].map((it) => (
                  <div key={it.k}>
                    <div style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>{it.k}</div>
                    <div className="serif" style={{ fontSize: 17 }}>{it.v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Hero swatch cluster */}
            <div style={{ position: "relative", height: 640 }} className="hero-imgs">
              <div style={{ position: "absolute", top: 0, right: 0, width: "72%", height: "78%" }}>
                <FabricSwatch
                  name="Saanjh"
                  gsm={120}
                  color="#B7472A"
                  colorName="Terracotta"
                  weave="plain"
                  aspect="auto"
                  size="lg"
                />
                <div style={{ position: "absolute", inset: 0 }}>
                  <FabricSwatch
                    name="Saanjh"
                    gsm={120}
                    color="#B7472A"
                    colorName="Terracotta"
                    weave="plain"
                    aspect="auto"
                    size="lg"
                  />
                </div>
              </div>
              <div style={{ position: "absolute", bottom: 0, left: 0, width: "52%", height: "46%", padding: 8, background: "var(--cream)" }}>
                <FabricSwatch
                  name="Noor"
                  gsm={110}
                  color="#FCFAF4"
                  colorName="Ivory"
                  weave="voile"
                  aspect="auto"
                  size="md"
                />
              </div>
              {/* floating tag */}
              <div style={{ position: "absolute", left: "44%", top: "38%", background: "var(--cream)", padding: "10px 14px", border: "1px solid var(--hairline-2)", borderRadius: 2, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 12px 32px rgba(44,40,38,0.08)", zIndex: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--terracotta)" }} />
                <div>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.12em" }}>Saanjh Kurta Set</div>
                  <div className="serif" style={{ fontSize: 16 }}>₹2,890</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* WIDE TYPE BAND */}
      <section style={{ borderTop: "1px solid var(--hairline-2)", borderBottom: "1px solid var(--hairline-2)", padding: "clamp(24px, 3.6vw, 40px) 0" }}>
        <div className="container" style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
          <div className="serif" style={{ fontSize: 24, fontStyle: "italic", color: "var(--charcoal)" }}>
            “If it isn't in the fabric, it isn't worth the price.”
          </div>
          <div style={{ fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--warm-grey)" }}>
            — A note from us, est. Surat 2025
          </div>
        </div>
      </section>

      {/* COLLECTION TILES */}
      <section style={{ background: "var(--cream-2)", padding: "clamp(56px, 9vw, 96px) 0" }}>
        <div className="container">
          <Reveal>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "clamp(28px, 4vw, 48px)", gap: 24, flexWrap: "wrap" }}>
              <div>
                <div className="eyebrow eyebrow-line" style={{ marginBottom: 12 }}>The wardrobe</div>
                <h2 className="display-lg" style={{ margin: 0 }}>Built around three ideas.</h2>
              </div>
              <p className="lede" style={{ maxWidth: 360, margin: 0 }}>
                Kurta sets for the everyday. Co-ords for the in-between. Festive pieces for the days that ask to be remembered.
              </p>
            </div>
          </Reveal>

          <div className="col-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24, alignItems: "stretch" }}>
            <Stagger step={120}>
              {COLLECTIONS.map((c, i) => (
                <button
                  key={c.slug}
                  onClick={() => navigate({ name: "collection", slug: c.slug })}
                  className="tapi-lift"
                  style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 20, cursor: "pointer", height: "100%" }}
                  data-comment-anchor={i === 0 ? "cc-2" : undefined}
                >
                  <div style={{ aspectRatio: "4/5", overflow: "hidden", width: "100%" }}>
                    <FabricSwatch
                      name={c.coverName}
                      gsm={c.coverGsm}
                      color={c.coverColor}
                      colorName={c.name.split(" ")[0]}
                      weave={c.coverWeave}
                      aspect="4/5"
                      size="lg"
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
                      <h3 className="serif" style={{ fontSize: 26, margin: 0 }}>{c.name}</h3>
                      <span className="tnum" style={{ fontSize: 11, color: "var(--muted)" }}>{c.count} pieces</span>
                    </div>
                    <div className="eyebrow" style={{ marginBottom: 10 }}>{c.tagline}</div>
                    <p style={{ fontSize: 14, color: "var(--warm-grey)", margin: 0, lineHeight: 1.6, flex: 1 }}>{c.blurb}</p>
                    <div className="tapi-arrow-slide" style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 10, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                      Explore {Icon.arrowLong}
                    </div>
                  </div>
                </button>
              ))}
            </Stagger>
          </div>
        </div>
      </section>

      {/* FEATURED PRODUCTS */}
      <section className="section">
        <div className="container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "clamp(24px, 3.4vw, 40px)", gap: 24, flexWrap: "wrap" }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Just arrived</div>
              <h2 className="h1" style={{ margin: 0 }}>This week, from our table to yours.</h2>
            </div>
            <button onClick={() => navigate({ name: "collection", slug: "kurta-sets" })} className="btn btn-ghost">View all {Icon.arrowRight}</button>
          </div>

          <div className="prod-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 28 }}>
            <Stagger step={100}>
              {PRODUCTS.slice(0, 4).map((p) => (
                <ProductCard key={p.id} p={p} onClick={openProduct} />
              ))}
            </Stagger>
          </div>
        </div>
      </section>

      {/* CRAFT STORY */}
      <section style={{ background: "var(--charcoal)", color: "var(--cream)", padding: "clamp(64px, 10vw, 120px) 0" }}>
        <div className="container">
          <div className="story-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "clamp(32px, 6vw, 80px)", alignItems: "center" }}>
            <div style={{ aspectRatio: "4/5", overflow: "hidden", background: "var(--cream-2)" }}>
              {/* Workroom fabric placeholder, dark-themed */}
              <div style={{
                width: "100%", height: "100%",
                background: `
                  repeating-linear-gradient(45deg, rgba(248,244,237,0.04) 0 1px, transparent 1px 5px),
                  repeating-linear-gradient(135deg, rgba(248,244,237,0.04) 0 1px, transparent 1px 5px),
                  linear-gradient(135deg, var(--charcoal-2), var(--charcoal))
                `,
                position: "relative",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexDirection: "column",
              }}>
                <div style={{ fontFamily: "var(--font-serif)", color: "var(--cream)", fontSize: 56, fontStyle: "italic", fontWeight: 400 }}>
                  the workroom
                </div>
                <div style={{ marginTop: 14, fontSize: 11, letterSpacing: "0.2em", color: "var(--terracotta-soft)", textTransform: "uppercase" }}>
                  Rampura, Surat — 2025
                </div>
                <div style={{ position: "absolute", bottom: 24, left: 24, fontSize: 10, letterSpacing: "0.2em", color: "var(--cream)", opacity: 0.4, textTransform: "uppercase" }}>archive 001</div>
                <div style={{ position: "absolute", bottom: 24, right: 24, fontSize: 10, letterSpacing: "0.2em", color: "var(--cream)", opacity: 0.4, textTransform: "uppercase" }}>roll · iv</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <span className="eyebrow" style={{ color: "var(--terracotta-soft)" }}>— Our making</span>
              <h2 className="display-lg" style={{ margin: 0, color: "var(--cream)" }}>
                Five hands,<br/>
                <em style={{ fontWeight: 500 }}>twelve looms away.</em>
              </h2>
              <p style={{ fontSize: 16, lineHeight: 1.75, color: "var(--cream)", opacity: 0.85, maxWidth: 520 }} data-comment-anchor="cc-1">
                It started at our family's dining table in Rampura. We've moved a few streets over since — but the cotton still comes from the same eleven weavers, and family still folds every order before it leaves.
              </p>
              <p style={{ fontSize: 16, lineHeight: 1.75, color: "var(--cream)", opacity: 0.7, maxWidth: 520 }}>
                Every product page lists the weight, the blend, the weave, and the model's measurements — because if you were buying from us in person, that's what you'd ask.
              </p>
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button onClick={() => navigate({ name: "about" })} className="btn" style={{ background: "var(--cream)", color: "var(--charcoal)" }}>
                  Our story
                </button>
                <button className="btn btn-ghost" style={{ color: "var(--cream)", border: "1px solid rgba(248,244,237,0.3)" }}>
                  How we work (2:14)
                </button>
              </div>
            </div>
          </div>

          {/* Studio strip */}
          <div className="studio-strip" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "clamp(20px, 3vw, 32px)", marginTop: "clamp(48px, 7vw, 80px)", paddingTop: "clamp(24px, 3.6vw, 40px)", borderTop: "1px solid rgba(248,244,237,0.12)" }}>
            {[
              { n: "11", l: "Weavers within walking distance" },
              { n: "5", l: "Family + cousin operations" },
              { n: "120–180", l: "GSM range — listed per piece" },
              { n: "48 hrs", l: "Pickup-ready in Surat" },
            ].map((it, i) => (
              <Reveal key={it.l} delay={i * 90}>
                <div>
                  <div className="serif tnum" style={{ fontSize: 44, lineHeight: 1, color: "var(--terracotta-soft)" }}>
                    <CountUp value={it.n} duration={1600} />
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--cream)", opacity: 0.7, letterSpacing: "0.06em", lineHeight: 1.5 }}>{it.l}</div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Press / testimonials */}
      <section style={{ background: "var(--cream-2)", padding: "clamp(48px, 8vw, 80px) 0" }}>
        <div className="container">
          <div className="press-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "clamp(20px, 3vw, 24px)" }}>
            <Stagger step={120}>
              {[
                { q: "The fabric is honest and the fit is honest. That's rare.", a: "@ananyam_", c: "Bengaluru" },
                { q: "Finally — a label that tells me the GSM.", a: "@priyareads", c: "Mumbai" },
                { q: "Best exchange experience I've had in Indian D2C.", a: "@snehakurien", c: "Pune" },
                { q: "The hem stitching is impeccable. Worth every rupee.", a: "@aartisays", c: "Delhi" },
              ].map((q, i) => (
                <figure key={i} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ fontSize: 36, color: "var(--terracotta)", lineHeight: 1, fontFamily: "var(--font-serif)" }}>“</div>
                  <blockquote className="serif" style={{ fontSize: 19, margin: 0, lineHeight: 1.4, fontStyle: "italic" }}>{q.q}</blockquote>
                  <figcaption style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                    <strong style={{ color: "var(--charcoal)", fontWeight: 500, letterSpacing: "0.04em" }}>{q.a}</strong> · {q.c}
                  </figcaption>
                </figure>
              ))}
            </Stagger>
          </div>
        </div>
      </section>

      {/* FABRIC GUIDE band */}
      <section className="section">
        <div className="container">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "clamp(32px, 5vw, 64px)", alignItems: "center" }} className="fabric-guide-grid">
            <div>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Know your fabric</div>
              <h2 className="display-lg" style={{ margin: 0 }}>120 GSM cotton is summer.<br/><em>180 GSM is the wedding.</em></h2>
              <p className="lede" style={{ marginTop: 20, maxWidth: 540 }}>
                We list the weight, weave, and blend on every piece. Lower GSMs (110–130) are featherweight cottons — light, airy, ideal for Mumbai-summer. Higher GSMs (160–180) hold structure — better for festive, photographs, the camera.
              </p>
              <button className="btn btn-outline" style={{ marginTop: 28 }}>Read the fabric guide {Icon.arrowRight}</button>
            </div>
            <div className="fabric-cards" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} data-comment-anchor="cc-2">
              {[
                { gsm: 110, weave: "voile", c: "#FCFAF4", n: "Voile", note: "Featherlight" },
                { gsm: 120, weave: "plain", c: "#B7472A", n: "Mulmul", note: "Everyday" },
                { gsm: 145, weave: "satin", c: "#7A8761", n: "Modal", note: "Drapes well" },
                { gsm: 180, weave: "dobby", c: "#B08947", n: "Dobby", note: "Festive" },
              ].map((f, i) => (
                <FabricSwatch
                  key={i}
                  name={f.n}
                  gsm={f.gsm}
                  color={f.c}
                  colorName={f.note}
                  weave={f.weave}
                  aspect="1 / 1"
                  size="sm"
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 980px) {
          .hero-grid { grid-template-columns: 1fr !important; gap: 32px !important; }
          .hero-imgs { height: 420px !important; }
          .col-grid { grid-template-columns: 1fr 1fr !important; }
          .story-grid { grid-template-columns: 1fr !important; gap: 32px !important; }
          .studio-strip { grid-template-columns: 1fr 1fr !important; gap: 24px !important; }
          .prod-grid { grid-template-columns: 1fr 1fr !important; }
          .press-row { grid-template-columns: 1fr 1fr !important; }
          .fabric-guide-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          .hero-imgs { height: 360px !important; }
          .col-grid { grid-template-columns: 1fr !important; gap: 32px !important; }
          .press-row { grid-template-columns: 1fr !important; }
          .fabric-cards { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>
    </main>
  );
};

window.HomePage = HomePage;
