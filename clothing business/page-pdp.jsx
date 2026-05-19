/* global React, Icon, FabricSwatch */
// Product Detail Page — fully interactive

const { useState: usePdpState, useMemo: usePdpMemo, useEffect: usePdpEffect } = React;

const PdpPage = ({ slug, navigate, addToCart, openSizeGuide }) => {
  const { PRODUCTS, REVIEWS, PINCODE_DELIVERY } = window.TAPI_DATA;
  const product = PRODUCTS.find((p) => p.slug === slug) || PRODUCTS[0];

  const [colorIdx, setColorIdx] = usePdpState(0);
  const color = product.colors[colorIdx];
  const [size, setSize] = usePdpState(null);
  const [qty, setQty] = usePdpState(1);
  const [pin, setPin] = usePdpState("");
  const [pinResult, setPinResult] = usePdpState(null);
  const [reviewTab, setReviewTab] = usePdpState("all");
  const [showQuiz, setShowQuiz] = usePdpState(false);

  const galleryViews = [
    { tag: "Front", weave: product.fabric.weaveKey },
    { tag: "Detail", weave: product.fabric.weaveKey },
    { tag: "Back", weave: product.fabric.weaveKey },
    { tag: "Hem study", weave: "voile" },
    { tag: "Worn", weave: product.fabric.weaveKey },
  ];
  const [activeView, setActiveView] = usePdpState(0);

  const stockForSize = size ? product.stockBySize[size] || 0 : null;

  const checkPin = () => {
    const prefix = pin.slice(0, 3);
    if (PINCODE_DELIVERY[prefix]) {
      setPinResult({ ok: true, ...PINCODE_DELIVERY[prefix] });
    } else if (pin.length === 6) {
      setPinResult({ ok: true, city: "Your address", days: [5, 7] });
    } else {
      setPinResult({ ok: false, msg: "Enter a 6-digit pincode" });
    }
  };

  const onAdd = () => {
    if (!size) {
      const el = document.getElementById("size-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    addToCart({ ...product, size, color: color.name, colorHex: color.hex, qty });
  };

  const productReviews = REVIEWS;
  const ratingBreakdown = [5, 4, 3, 2, 1].map((s) => ({
    s,
    n: productReviews.filter((r) => r.rating === s).length,
    pct: Math.round((productReviews.filter((r) => r.rating === s).length / productReviews.length) * 100),
  }));

  return (
    <main style={{ paddingTop: "clamp(12px, 2vw, 24px)" }} className="has-mobile-cta">
      <div className="container" style={{ fontSize: 12, color: "var(--muted)", marginBottom: "clamp(12px, 2vw, 24px)" }}>
        <button onClick={() => navigate({ name: "home" })}>Home</button> &nbsp;/&nbsp;
        <button onClick={() => navigate({ name: "collection", slug: product.collectionSlug })}>{product.collection}</button> &nbsp;/&nbsp;
        <span style={{ color: "var(--charcoal)" }}>{product.fullName}</span>
      </div>

      <div className="container">
        <div className="pdp-grid" style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: "clamp(20px, 3vw, 32px)" }}>
          {/* Thumbnails rail */}
          <div className="pdp-thumbs" style={{ display: "flex", flexDirection: "column", gap: 8, width: 64 }}>
            {galleryViews.map((v, i) => (
              <button key={i} onClick={() => setActiveView(i)} style={{ width: 64, height: 80, position: "relative", border: i === activeView ? "1px solid var(--charcoal)" : "1px solid var(--hairline-2)", padding: 2 }}>
                <FabricSwatch
                  name={product.name}
                  gsm={product.fabric.gsm}
                  color={color.hex}
                  colorName={color.name}
                  weave={v.weave}
                  aspect="auto"
                  size="sm"
                  showMeta={false}
                  withCorners={false}
                />
                <span style={{ position: "absolute", bottom: -2, left: 0, right: 0, fontSize: 8, letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", color: i === activeView ? "var(--terracotta)" : "var(--muted)" }}>
                  {v.tag.slice(0, 3)}
                </span>
              </button>
            ))}
          </div>

          {/* Main image */}
          <div style={{ position: "relative" }}>
            <div style={{ position: "sticky", top: 130 }}>
              <div style={{ position: "relative", overflow: "hidden" }}>
                <div key={activeView} className="tapi-rise" style={{ animation: "tapi-rise 480ms cubic-bezier(0.16,1,0.3,1) both" }}>
                  <FabricSwatch
                    name={product.name}
                    gsm={product.fabric.gsm}
                    color={color.hex}
                    colorName={color.name}
                    weave={galleryViews[activeView].weave}
                    aspect="3 / 4"
                    size="lg"
                  />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, fontSize: 11, color: "var(--muted)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
                <span>View {activeView + 1} / {galleryViews.length} — {galleryViews[activeView].tag}</span>
                <span>Placeholder · swap with product photo</span>
              </div>
            </div>
          </div>

          {/* Buy column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {product.tags.includes("new") && <span className="tag tag-charcoal">New</span>}
                {product.tags.includes("bestseller") && <span className="tag tag-sage">Bestseller</span>}
                {product.tags.includes("festive") && <span className="tag tag-terracotta">Festive</span>}
              </div>
              <h1 className="display-lg" style={{ margin: 0, fontSize: 44 }}>{product.fullName}</h1>
              <p className="lede" style={{ marginTop: 8 }}>{product.subtitle} · {product.pieces.join(" · ")}</p>
            </div>

            {/* Rating + reviews */}
            <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 16, borderBottom: "1px solid var(--hairline)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {[1,2,3,4,5].map((s) => (
                  <span key={s} style={{ color: s <= Math.round(product.rating) ? "var(--terracotta)" : "var(--hairline-2)", fontSize: 18 }}>★</span>
                ))}
                <span className="tnum" style={{ fontSize: 14, fontWeight: 500 }}>{product.rating}</span>
              </div>
              <span style={{ width: 1, height: 16, background: "var(--hairline-2)" }} />
              <a href="#reviews" style={{ fontSize: 13, color: "var(--warm-grey)", textDecoration: "underline", textUnderlineOffset: 4 }}>
                {product.reviewCount} reviews
              </a>
            </div>

            {/* Price */}
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span className="serif tnum" style={{ fontSize: 32, fontWeight: 500 }}>{product.currency}{product.price.toLocaleString("en-IN")}</span>
              {product.compareAt && (
                <>
                  <span className="tnum" style={{ fontSize: 18, color: "var(--muted)", textDecoration: "line-through" }}>{product.currency}{product.compareAt.toLocaleString("en-IN")}</span>
                  <span className="tag tag-terracotta">Save {product.currency}{(product.compareAt - product.price).toLocaleString("en-IN")}</span>
                </>
              )}
            </div>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: 0, marginTop: -8 }}>Inclusive of taxes. Free shipping above ₹2,499.</p>

            {/* Color */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <span className="eyebrow">Color · {color.name}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{product.colors.length} options</span>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                {product.colors.map((c, i) => (
                  <button key={c.name} onClick={() => setColorIdx(i)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                    <span style={{
                      width: 36, height: 36, borderRadius: "50%",
                      background: c.hex,
                      border: i === colorIdx ? "1.5px solid var(--charcoal)" : "1px solid var(--hairline-2)",
                      outline: i === colorIdx ? "1.5px solid var(--cream)" : "none",
                      outlineOffset: -5,
                    }} />
                    <span style={{ fontSize: 10, color: i === colorIdx ? "var(--charcoal)" : "var(--muted)", letterSpacing: "0.06em" }}>{c.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Size */}
            <div id="size-section">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <span className="eyebrow">Size {size ? `· ${size}` : ""}</span>
                <div style={{ display: "flex", gap: 16 }}>
                  <button onClick={openSizeGuide} className="link-u" style={{ fontSize: 12, color: "var(--charcoal)", display: "inline-flex", gap: 4, alignItems: "center" }}>
                    {Icon.ruler} Size guide
                  </button>
                  <button onClick={() => setShowQuiz(true)} className="link-u" style={{ fontSize: 12, color: "var(--terracotta)" }}>Find my size →</button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {product.sizes.map((s) => {
                  const stock = product.stockBySize[s] || 0;
                  const out = stock === 0;
                  const low = stock > 0 && stock <= 3;
                  const sel = size === s;
                  return (
                    <button
                      key={s}
                      onClick={() => !out && setSize(s)}
                      disabled={out}
                      style={{
                        position: "relative",
                        height: 48, minWidth: 48, padding: "0 14px",
                        border: "1px solid " + (sel ? "var(--charcoal)" : "var(--hairline-2)"),
                        background: sel ? "var(--charcoal)" : "transparent",
                        color: sel ? "var(--cream)" : (out ? "var(--muted)" : "var(--charcoal)"),
                        fontSize: 13, fontWeight: 500, letterSpacing: "0.04em",
                        cursor: out ? "not-allowed" : "pointer",
                        opacity: out ? 0.5 : 1,
                      }}
                    >
                      {s}
                      {out && <span style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "var(--muted)", transform: "rotate(-12deg)" }} />}
                      {low && !sel && <span style={{ position: "absolute", top: -6, right: -6, width: 6, height: 6, background: "var(--terracotta)", borderRadius: "50%" }} />}
                    </button>
                  );
                })}
              </div>
              {size && (
                <p style={{ marginTop: 12, fontSize: 12, color: stockForSize <= 3 ? "var(--terracotta)" : "var(--warm-grey)" }}>
                  {stockForSize <= 3 ? `Only ${stockForSize} left in size ${size}` : `In stock — ships in 1–2 days`}
                </p>
              )}
              <div style={{ marginTop: 16, padding: 14, background: "var(--cream-2)", borderRadius: "var(--r-xs)", fontSize: 13, lineHeight: 1.6 }}>
                <strong style={{ fontFamily: "var(--font-serif)", fontSize: 14 }}>Fit feedback from {product.reviewCount} buyers</strong>
                <FitBar fb={product.fitFeedback} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--warm-grey)" }}>
                  <span>{product.fitFeedback.sizeDown}% size down</span>
                  <span>{product.fitFeedback.runsTrue}% true</span>
                  <span>{product.fitFeedback.sizeUp}% size up</span>
                </div>
              </div>
            </div>

            {/* QTY + CTAs */}
            <div className="pdp-desktop-cta" style={{ display: "flex", gap: 12, flexDirection: "column" }}>
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--hairline-2)" }}>
                  <button onClick={() => setQty(Math.max(1, qty - 1))} style={{ width: 48, height: 56, fontSize: 18 }}>−</button>
                  <span className="tnum" style={{ width: 40, textAlign: "center", fontSize: 15 }}>{qty}</span>
                  <button onClick={() => setQty(qty + 1)} style={{ width: 48, height: 56, fontSize: 18 }}>+</button>
                </div>
                <button onClick={onAdd} className="btn btn-primary btn-lg" style={{ flex: 1, height: 56 }}>
                  Add to bag — {product.currency}{(product.price * qty).toLocaleString("en-IN")}
                </button>
              </div>
              <button className="btn btn-terracotta btn-lg" style={{ height: 56 }}>Buy it now</button>
            </div>

            {/* Pincode */}
            <div style={{ border: "1px solid var(--hairline)", padding: 16, background: "var(--ivory)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                {Icon.truck}
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>Delivery &amp; pickup</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  placeholder="Enter pincode"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  style={{ height: 40 }}
                />
                <button onClick={checkPin} className="btn" style={{ background: "var(--charcoal)", color: "var(--cream)", height: 40 }}>Check</button>
              </div>
              {pinResult && pinResult.ok && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)", display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--sage-deep)" }}>{Icon.check}</span>
                    <span>Deliverable to <strong>{pinResult.city}</strong> in <strong className="tnum">{pinResult.days[0]}–{pinResult.days[1]} days</strong></span>
                  </div>
                  {pinResult.pickup && (
                    <div style={{ marginTop: 4, padding: 12, background: "var(--terracotta-wash)", borderRadius: 2, display: "flex", alignItems: "center", gap: 10 }}>
                      {Icon.pin}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: "var(--font-serif)", fontSize: 14 }}>Pick up from us · save ₹50</div>
                        <div style={{ fontSize: 11, color: "var(--warm-grey)" }}>Ready in 48 hrs at Rampura, Surat</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {pinResult && !pinResult.ok && (
                <p style={{ marginTop: 8, fontSize: 12, color: "var(--terracotta)" }}>{pinResult.msg}</p>
              )}
            </div>

            {/* Trust accordion */}
            <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--hairline)" }}>
              {[
                { t: "Description", c: product.description },
                { t: "Fabric &amp; care", c: <FabricTable f={product.fabric} /> },
                { t: "Model &amp; fit", c: <ModelInfo m={product.model} /> },
                { t: "Shipping &amp; returns", c: "Free shipping above ₹2,499 · 7-day exchange window on your first order · Pickup from Surat available." },
              ].map((row, i) => (
                <Accordion key={i} title={row.t} content={row.c} defaultOpen={i === 1} />
              ))}
            </div>
          </div>
        </div>

        {/* Reviews section */}
        <section id="reviews" style={{ marginTop: "clamp(64px, 10vw, 120px)", paddingTop: "clamp(32px, 5vw, 56px)", borderTop: "1px solid var(--hairline)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: "clamp(32px, 5vw, 64px)" }} className="rev-grid">
            <div style={{ position: "sticky", top: 130, alignSelf: "start" }}>
              <span className="eyebrow">Reviews</span>
              <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 12 }}>
                <span className="serif tnum" style={{ fontSize: 64, fontWeight: 500, lineHeight: 1 }}>{product.rating}</span>
                <span style={{ color: "var(--warm-grey)" }}>/ 5</span>
              </div>
              <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
                {[1,2,3,4,5].map((s) => <span key={s} style={{ color: s <= Math.round(product.rating) ? "var(--terracotta)" : "var(--hairline-2)" }}>★</span>)}
              </div>
              <p style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>From {product.reviewCount} verified buyers</p>

              <div style={{ marginTop: 32, display: "flex", flexDirection: "column", gap: 8 }}>
                {ratingBreakdown.map((r) => (
                  <div key={r.s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 12 }}>{r.s}★</span>
                    <span style={{ flex: 1, height: 4, background: "var(--cream-2)", overflow: "hidden" }}>
                      <span style={{ display: "block", width: `${r.pct}%`, height: "100%", background: "var(--charcoal)" }} />
                    </span>
                    <span className="tnum" style={{ width: 28, textAlign: "right", color: "var(--muted)" }}>{r.n}</span>
                  </div>
                ))}
              </div>

              <button className="btn btn-outline" style={{ marginTop: 32, width: "100%" }}>Write a review</button>
            </div>

            <div>
              <div style={{ display: "flex", gap: 4, marginBottom: 32, borderBottom: "1px solid var(--hairline)" }}>
                {["all", "with photos", "size up", "fits perfect"].map((t) => (
                  <button key={t} onClick={() => setReviewTab(t)} style={{
                    padding: "12px 16px",
                    fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase",
                    borderBottom: reviewTab === t ? "1px solid var(--charcoal)" : "1px solid transparent",
                    color: reviewTab === t ? "var(--charcoal)" : "var(--warm-grey)",
                  }}>{t}</button>
                ))}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                {productReviews.map((r, i) => (
                  <div key={i} style={{ paddingBottom: 32, borderBottom: i < productReviews.length - 1 ? "1px solid var(--hairline)" : "none" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--cream-2)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-serif)", fontSize: 16 }}>{r.name[0]}</div>
                        <div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <strong style={{ fontSize: 14 }}>{r.name}</strong>
                            {r.verified && <span style={{ fontSize: 10, color: "var(--sage-deep)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Verified buyer</span>}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{r.city} · Size {r.size} · {r.daysAgo} days ago</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 2 }}>
                        {[1,2,3,4,5].map((s) => <span key={s} style={{ color: s <= r.rating ? "var(--terracotta)" : "var(--hairline-2)" }}>★</span>)}
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.65 }}>{r.body}</p>
                    <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 11, color: "var(--muted)" }}>
                      <span>Fit: <strong style={{ color: "var(--charcoal)" }}>{r.fit}</strong></span>
                      {r.photos > 0 && <span>📷 {r.photos} photos</span>}
                    </div>
                  </div>
                ))}
              </div>

              <button className="btn btn-outline" style={{ marginTop: 32 }}>Load more reviews</button>
            </div>
          </div>
        </section>

        {/* You may also like */}
        <section style={{ marginTop: "clamp(64px, 10vw, 120px)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "clamp(20px, 3vw, 32px)" }}>
            <h2 className="h1" style={{ margin: 0 }}>You may also like</h2>
            <button className="btn btn-ghost" onClick={() => navigate({ name: "collection", slug: product.collectionSlug })}>View all {Icon.arrowRight}</button>
          </div>
          <div className="prod-grid-pdp" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "clamp(16px, 2.4vw, 24px)" }}>
            {PRODUCTS.filter((p) => p.id !== product.id).slice(0, 4).map((p) => (
              <window.ProductCard key={p.id} p={p} onClick={(prod) => navigate({ name: "product", slug: prod.slug })} />
            ))}
          </div>
        </section>
      </div>

      {showQuiz && <SizeQuiz product={product} onClose={() => setShowQuiz(false)} onPick={(s) => { setSize(s); setShowQuiz(false); }} />}

      {/* Mobile-only sticky Add to Bag bar */}
      <div className="pdp-mobile-cta" style={{
        position: "fixed", left: 0, right: 0, bottom: 0,
        background: "var(--cream)", borderTop: "1px solid var(--hairline-2)",
        padding: "10px 16px", paddingBottom: "calc(10px + env(safe-area-inset-bottom))",
        zIndex: 80,
        display: "none",
        boxShadow: "0 -8px 24px rgba(44,40,38,0.06)",
      }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ flex: "0 0 auto" }}>
            <div className="serif tnum" style={{ fontSize: 18, fontWeight: 500, lineHeight: 1 }}>{product.currency}{product.price.toLocaleString("en-IN")}</div>
            {product.compareAt && <div className="tnum" style={{ fontSize: 10, color: "var(--muted)", textDecoration: "line-through", marginTop: 2 }}>{product.currency}{product.compareAt.toLocaleString("en-IN")}</div>}
          </div>
          <button onClick={onAdd} className="btn btn-primary" style={{ flex: 1, height: 52, fontSize: 12 }}>
            {size ? `Add · size ${size}` : "Select size"}
          </button>
        </div>
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .pdp-grid { grid-template-columns: 1fr !important; }
          .pdp-thumbs { flex-direction: row !important; width: 100% !important; flex-wrap: wrap; }
          .rev-grid { grid-template-columns: 1fr !important; }
          .prod-grid-pdp { grid-template-columns: repeat(3, 1fr) !important; }
        }
        @media (max-width: 700px) {
          .pdp-grid { gap: 20px !important; }
          .pdp-thumbs { gap: 6px !important; }
          .pdp-thumbs button { width: 56px !important; height: 70px !important; }
          .pdp-mobile-cta { display: block !important; }
          .pdp-desktop-cta { display: none !important; }
          .prod-grid-pdp { grid-template-columns: 1fr 1fr !important; }
          h1.display-lg { font-size: 32px !important; }
        }
        @media (max-width: 480px) {
          .prod-grid-pdp { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </main>
  );
};

// ------- Sub-components -------
const FitBar = ({ fb }) => {
  const [ref, inView] = (window.useReveal || (() => [null, true]))({ threshold: 0.4 });
  const widths = inView ? fb : { sizeDown: 0, runsTrue: 0, sizeUp: 0 };
  return (
    <div ref={ref} style={{ marginTop: 8, display: "flex", gap: 12, alignItems: "center" }}>
      <span style={{ flex: 1, height: 6, background: "var(--cream)", borderRadius: 3, overflow: "hidden", display: "flex" }}>
        <span style={{ width: `${widths.sizeDown}%`, background: "var(--terracotta-soft)", transition: "width 1200ms cubic-bezier(0.16,1,0.3,1)" }} />
        <span style={{ width: `${widths.runsTrue}%`, background: "var(--sage)", transition: "width 1200ms cubic-bezier(0.16,1,0.3,1) 120ms" }} />
        <span style={{ width: `${widths.sizeUp}%`, background: "var(--terracotta)", transition: "width 1200ms cubic-bezier(0.16,1,0.3,1) 240ms" }} />
      </span>
    </div>
  );
};

const Accordion = ({ title, content, defaultOpen = false }) => {
  const [open, setOpen] = usePdpState(defaultOpen);
  return (
    <div style={{ borderBottom: "1px solid var(--hairline)" }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "18px 0" }}>
        <span style={{ fontFamily: "var(--font-serif)", fontSize: 17 }} dangerouslySetInnerHTML={{ __html: title }} />
        <span style={{ fontSize: 20, color: "var(--warm-grey)" }}>{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div style={{ paddingBottom: 20, fontSize: 14, lineHeight: 1.7, color: "var(--warm-grey)" }}>
          {typeof content === "string" ? <p style={{ margin: 0 }}>{content}</p> : content}
        </div>
      )}
    </div>
  );
};

const FabricTable = ({ f }) => (
  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
    <tbody>
      {[
        ["GSM", f.gsm + " gsm"],
        ["Blend", f.blend],
        ["Weave", f.weave],
        ["Fit type", f.fitType],
        ["Opacity", f.opacity],
        ["Breathability", f.breath],
        ["Wash care", f.washCare],
      ].map(([k, v]) => (
        <tr key={k} style={{ borderBottom: "1px dashed var(--hairline)" }}>
          <td style={{ padding: "10px 0", color: "var(--muted)", letterSpacing: "0.04em", width: "40%" }}>{k}</td>
          <td style={{ padding: "10px 0", color: "var(--charcoal)" }}>{v}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const ModelInfo = ({ m }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 13 }}>
    {[
      ["Height", m.height],
      ["Wearing size", m.size],
      ["Bust", m.bust + "\""],
      ["Waist", m.waist + "\""],
      ["Fit feedback", m.fitNote, true],
    ].map(([k, v, full]) => (
      <div key={k} style={{ gridColumn: full ? "1 / -1" : "auto", paddingBottom: 12, borderBottom: "1px dashed var(--hairline)" }}>
        <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>{k}</div>
        <div style={{ color: "var(--charcoal)" }}>{v}</div>
      </div>
    ))}
  </div>
);

// ------- Size Quiz -------
const SizeQuiz = ({ product, onClose, onPick }) => {
  const [step, setStep] = usePdpState(0);
  const [ans, setAns] = usePdpState({ height: null, weight: null, fit: null, similar: null });

  const steps = [
    { k: "height", q: "Your height?", opts: [
      { v: "<5'2\"", l: "Under 5'2\"" },
      { v: "5'2-5'5", l: "5'2\" – 5'5\"" },
      { v: "5'5-5'8", l: "5'5\" – 5'8\"" },
      { v: ">5'8", l: "Over 5'8\"" },
    ]},
    { k: "weight", q: "Your usual bust measurement?", opts: [
      { v: 32, l: "32\"" }, { v: 34, l: "34\"" }, { v: 36, l: "36\"" }, { v: 38, l: "38\"" }, { v: 40, l: "40\"+" },
    ]},
    { k: "fit", q: "How do you like your kurta to fit?", opts: [
      { v: "snug", l: "Snug — close to body" },
      { v: "true", l: "True — comfortable, not loose" },
      { v: "relaxed", l: "Relaxed — easy, breezy" },
    ]},
    { k: "similar", q: "A brand whose size fits you well?", opts: [
      { v: "good-earth", l: "Good Earth" },
      { v: "fab-india", l: "FabIndia" },
      { v: "anokhi", l: "Anokhi" },
      { v: "skip", l: "Skip this — I don't know" },
    ]},
  ];

  // Compute recommendation from answers (simple heuristic)
  const recommend = () => {
    const w = ans.weight || 34;
    let s = "S";
    if (w <= 32) s = "XS";
    else if (w <= 34) s = "S";
    else if (w <= 36) s = "M";
    else if (w <= 38) s = "L";
    else s = "XL";
    // Adjust for fit preference
    if (ans.fit === "relaxed") {
      const order = ["XS", "S", "M", "L", "XL", "XXL"];
      const idx = order.indexOf(s);
      if (idx < order.length - 1) s = order[idx + 1];
    }
    return s;
  };

  const onAnswer = (k, v) => {
    const next = { ...ans, [k]: v };
    setAns(next);
    if (step < steps.length - 1) {
      setTimeout(() => setStep(step + 1), 120);
    } else {
      setTimeout(() => setStep(steps.length), 120);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(44,40,38,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "var(--cream)", maxWidth: 520, width: "100%", padding: 32, position: "relative" }}>
        <button onClick={onClose} style={{ position: "absolute", top: 16, right: 16 }}>{Icon.close}</button>
        {step < steps.length ? (
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Step {step + 1} of {steps.length}</div>
            <h3 className="h2" style={{ margin: "0 0 24px" }}>{steps[step].q}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {steps[step].opts.map((o) => (
                <button key={o.v} onClick={() => onAnswer(steps[step].k, o.v)} style={{
                  padding: "16px 20px",
                  border: "1px solid var(--hairline-2)",
                  background: ans[steps[step].k] === o.v ? "var(--charcoal)" : "var(--ivory)",
                  color: ans[steps[step].k] === o.v ? "var(--cream)" : "var(--charcoal)",
                  textAlign: "left", fontSize: 15,
                  transition: "all 160ms",
                }}>{o.l}</button>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, fontSize: 12, color: "var(--muted)" }}>
              <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={{ opacity: step === 0 ? 0.4 : 1 }}>← Back</button>
              <span>{step + 1} / {steps.length}</span>
            </div>
          </div>
        ) : (
          <div>
            <div className="eyebrow" style={{ marginBottom: 16, color: "var(--terracotta)" }}>Your recommended size</div>
            <div className="serif" style={{ fontSize: 96, lineHeight: 1, fontWeight: 500 }}>{recommend()}</div>
            <p style={{ marginTop: 12, color: "var(--warm-grey)", fontSize: 14, lineHeight: 1.6 }}>
              Based on your measurements and that you prefer a <em>{ans.fit || "true"}</em> fit. {product.fitFeedback.runsTrue}% of buyers say this product runs true to size.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
              <button onClick={() => onPick(recommend())} className="btn btn-primary" style={{ flex: 1 }}>Use this size</button>
              <button onClick={() => setStep(0)} className="btn btn-outline">Retake</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

window.PdpPage = PdpPage;
