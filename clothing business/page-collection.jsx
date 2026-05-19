/* global React, Icon, ProductCard */
// Collection / category page

const { useState: useColl, useMemo: useCollMemo } = React;

const CollectionPage = ({ slug, navigate, openProduct }) => {
  const { PRODUCTS, COLLECTIONS } = window.TAPI_DATA;
  const collection = COLLECTIONS.find((c) => c.slug === slug) || COLLECTIONS[0];

  const [sortBy, setSortBy] = useColl("featured");
  const [activePrice, setActivePrice] = useColl(null);
  const [activeColor, setActiveColor] = useColl([]);
  const [activeSize, setActiveSize] = useColl([]);
  const [filtersOpen, setFiltersOpen] = useColl(false);

  const visible = useCollMemo(() => {
    let v = [...PRODUCTS];
    if (activePrice) {
      const [min, max] = activePrice;
      v = v.filter((p) => p.price >= min && p.price <= max);
    }
    if (sortBy === "low") v.sort((a, b) => a.price - b.price);
    if (sortBy === "high") v.sort((a, b) => b.price - a.price);
    if (sortBy === "new") v.sort((a, b) => (b.tags.includes("new") ? 1 : 0) - (a.tags.includes("new") ? 1 : 0));
    return v;
  }, [sortBy, activePrice, activeColor, activeSize]);

  const filterCount = (activePrice ? 1 : 0) + activeColor.length + activeSize.length;

  const FilterGroup = ({ title, children, defaultOpen = true }) => {
    const [open, setOpen] = useColl(defaultOpen);
    return (
      <div style={{ borderBottom: "1px solid var(--hairline)", padding: "20px 0" }}>
        <button onClick={() => setOpen(!open)} style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", padding: 0 }}>
          <span style={{ fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500 }}>{title}</span>
          <span style={{ fontSize: 18, color: "var(--warm-grey)" }}>{open ? "–" : "+"}</span>
        </button>
        {open && <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>}
      </div>
    );
  };

  const Check = ({ label, count, on, toggle }) => (
    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer", color: on ? "var(--charcoal)" : "var(--warm-grey)" }} onClick={toggle}>
      <span style={{ width: 14, height: 14, border: "1px solid var(--charcoal)", background: on ? "var(--charcoal)" : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        {on && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5l3 3 5-7" stroke="var(--cream)" strokeWidth="1.5" fill="none"/></svg>}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && <span className="tnum" style={{ fontSize: 11, color: "var(--muted)" }}>({count})</span>}
    </label>
  );

  return (
    <main>
      {/* Header */}
      <section style={{ padding: "clamp(28px, 4.6vw, 48px) 0 clamp(20px, 3vw, 32px)", borderBottom: "1px solid var(--hairline)" }}>
        <div className="container">
          <div style={{ fontSize: 12, color: "var(--muted)", letterSpacing: "0.06em", marginBottom: 16 }}>
            <button onClick={() => navigate({ name: "home" })}>Home</button> &nbsp;/&nbsp; <span>{collection.name}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
            <div>
              <h1 className="display-lg" style={{ margin: 0 }}>{collection.name}</h1>
              <p className="lede" style={{ marginTop: 12, maxWidth: 560 }}>{collection.blurb}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }} className="tnum">{visible.length} pieces</span>
              <div style={{ width: 1, height: 16, background: "var(--hairline-2)" }} />
              <window.Dropdown
                label="Sort:"
                value={sortBy}
                onChange={setSortBy}
                options={[
                  { value: "featured", label: "Featured", hint: "Editor's pick" },
                  { value: "new", label: "Newest first", hint: "Drop order" },
                  { value: "low", label: "Price · low to high" },
                  { value: "high", label: "Price · high to low" },
                ]}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Body */}
      <section style={{ padding: "clamp(24px, 4vw, 40px) 0 clamp(48px, 8vw, 80px)" }}>
        <div className="container">
          {/* Mobile filter trigger */}
          <div className="coll-mobile-bar" style={{ display: "none", justifyContent: "space-between", alignItems: "center", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--hairline)" }}>
            <button onClick={() => setFiltersOpen(true)} className="btn btn-outline btn-sm">
              Filter {filterCount > 0 && <span style={{ marginLeft: 4 }} className="tnum">({filterCount})</span>}
            </button>
            <span style={{ fontSize: 12, color: "var(--muted)" }} className="tnum">{visible.length} pieces</span>
          </div>

          <div className="coll-grid" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: "clamp(28px, 4.4vw, 56px)", alignItems: "start" }}>
            {/* Filter backdrop (mobile only) */}
            {filtersOpen && (
              <div className="coll-mobile-backdrop" onClick={() => setFiltersOpen(false)}
                   style={{ display: "none", position: "fixed", inset: 0, background: "rgba(44,40,38,0.5)", zIndex: 90 }} />
            )}

            {/* Filter rail */}
            <aside className={"coll-filters " + (filtersOpen ? "is-open" : "")} style={{ position: "sticky", top: 130 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <span className="eyebrow">Filter</span>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {filterCount > 0 && (
                    <button onClick={() => { setActivePrice(null); setActiveColor([]); setActiveSize([]); }} style={{ fontSize: 11, color: "var(--terracotta)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      Clear ({filterCount})
                    </button>
                  )}
                  <button onClick={() => setFiltersOpen(false)} className="coll-mobile-close" style={{ display: "none", fontSize: 22, lineHeight: 1 }} aria-label="Close filters">×</button>
                </div>
              </div>

              <FilterGroup title="Price">
                {[
                  { label: "Under ₹2,500", range: [0, 2499], count: 1 },
                  { label: "₹2,500 – 3,500", range: [2500, 3500], count: 3 },
                  { label: "₹3,500 – 5,000", range: [3500, 5000], count: 2 },
                  { label: "Above ₹5,000", range: [5000, 100000], count: 0 },
                ].map((p) => (
                  <Check
                    key={p.label}
                    label={p.label}
                    count={p.count}
                    on={activePrice && activePrice[0] === p.range[0]}
                    toggle={() => setActivePrice(activePrice && activePrice[0] === p.range[0] ? null : p.range)}
                  />
                ))}
              </FilterGroup>

              <FilterGroup title="Fabric">
                {["Mulmul cotton", "Cotton-modal", "Cotton voile", "Silk-cotton", "Twill viscose"].map((f) => (
                  <Check key={f} label={f} on={false} toggle={() => {}} />
                ))}
              </FilterGroup>

              <FilterGroup title="Color">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
                  {[
                    { c: "#B7472A", n: "Terracotta" },
                    { c: "#7A8761", n: "Sage" },
                    { c: "#FCFAF4", n: "Ivory" },
                    { c: "#2C2826", n: "Charcoal" },
                    { c: "#B08947", n: "Gold" },
                    { c: "#6B2F3D", n: "Wine" },
                  ].map((c) => (
                    <button key={c.n} onClick={() => setActiveColor(activeColor.includes(c.n) ? activeColor.filter((x) => x !== c.n) : [...activeColor, c.n])} aria-label={c.n} style={{ width: 28, height: 28, borderRadius: "50%", background: c.c, border: activeColor.includes(c.n) ? "2px solid var(--charcoal)" : "1px solid var(--hairline-2)", outline: activeColor.includes(c.n) ? "2px solid var(--cream)" : "none", outlineOffset: -4 }} />
                  ))}
                </div>
              </FilterGroup>

              <FilterGroup title="Size">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {["XS", "S", "M", "L", "XL", "XXL"].map((s) => (
                    <button
                      key={s}
                      onClick={() => setActiveSize(activeSize.includes(s) ? activeSize.filter((x) => x !== s) : [...activeSize, s])}
                      style={{ width: 40, height: 32, border: "1px solid " + (activeSize.includes(s) ? "var(--charcoal)" : "var(--hairline-2)"), background: activeSize.includes(s) ? "var(--charcoal)" : "transparent", color: activeSize.includes(s) ? "var(--cream)" : "var(--charcoal)", fontSize: 12, letterSpacing: "0.04em" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </FilterGroup>

              <FilterGroup title="Fit" defaultOpen={false}>
                {["Relaxed", "Regular", "Slim"].map((f) => (
                  <Check key={f} label={f} on={false} toggle={() => {}} />
                ))}
              </FilterGroup>

              <FilterGroup title="Occasion" defaultOpen={false}>
                {["Everyday", "Festive", "Wedding", "Office"].map((f) => (
                  <Check key={f} label={f} on={false} toggle={() => {}} />
                ))}
              </FilterGroup>
            </aside>

            {/* Grid */}
            <div>
              {filterCount > 0 && (
                <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
                  {activePrice && (
                    <button onClick={() => setActivePrice(null)} className="tag" style={{ cursor: "pointer", gap: 8 }}>
                      ₹{activePrice[0]}–{activePrice[1]} ✕
                    </button>
                  )}
                  {activeColor.map((f) => <button key={f} onClick={() => setActiveColor(activeColor.filter((x) => x !== f))} className="tag">{f} ✕</button>)}
                  {activeSize.map((f) => <button key={f} onClick={() => setActiveSize(activeSize.filter((x) => x !== f))} className="tag">Size {f} ✕</button>)}
                </div>
              )}

              <div className="prod-grid-coll" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 28, rowGap: 56 }}>
                {visible.map((p) => (
                  <ProductCard key={p.id} p={p} onClick={openProduct} />
                ))}
              </div>

              {visible.length >= 4 && (
                <div style={{ marginTop: 64, padding: 48, background: "var(--cream-2)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, alignItems: "center" }} className="coll-band">
                  <div>
                    <span className="eyebrow" style={{ color: "var(--terracotta)" }}>— A note from the studio</span>
                    <h3 className="h2" style={{ margin: "12px 0 12px" }}>
                      “If it isn't in the fabric, it isn't worth the price.”
                    </h3>
                    <p style={{ color: "var(--warm-grey)", lineHeight: 1.7, margin: 0, fontSize: 15 }}>
                      Every kurta set in this drop lists its GSM — the weight of the fabric per square metre. Higher isn't always better; it depends on the season and the silhouette.
                    </p>
                  </div>
                  <button className="btn btn-outline" style={{ alignSelf: "start", justifySelf: "end" }}>Read our fabric guide {Icon.arrowRight}</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <style>{`
        @media (max-width: 1000px) {
          .coll-grid { grid-template-columns: 1fr !important; }
          .coll-filters { position: static !important; }
          .prod-grid-coll { grid-template-columns: 1fr 1fr !important; }
          .coll-band { grid-template-columns: 1fr !important; padding: 28px !important; }
        }
        @media (max-width: 700px) {
          .coll-mobile-bar { display: flex !important; }
          .coll-mobile-close { display: block !important; }
          .coll-mobile-backdrop { display: block !important; }
          .coll-filters {
            position: fixed !important;
            top: 0 !important; right: 0; bottom: 0;
            width: 84%; max-width: 340px;
            background: var(--cream);
            padding: 24px;
            z-index: 100;
            overflow-y: auto;
            transform: translateX(100%);
            transition: transform 280ms cubic-bezier(0.22,1,0.36,1);
          }
          .coll-filters.is-open { transform: translateX(0); }
        }
        @media (max-width: 540px) {
          .prod-grid-coll { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </main>
  );
};

window.CollectionPage = CollectionPage;
