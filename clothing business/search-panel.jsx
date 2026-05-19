/* global React, Icon */
// Search panel — opens below the header search icon, NOT a modal.

const { useState: useSearchState, useEffect: useSearchEffect, useRef: useSearchRef } = React;

const SearchPanel = ({ open, onClose, navigate, openProduct }) => {
  const [q, setQ] = useSearchState("");
  const inputRef = useSearchRef(null);
  const { PRODUCTS, COLLECTIONS } = window.TAPI_DATA;

  useSearchEffect(() => {
    if (open) {
      // small delay to let the slide-down finish before stealing focus
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    } else {
      setQ("");
    }
  }, [open]);

  useSearchEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const matches = q.trim().length === 0
    ? PRODUCTS.slice(0, 3)
    : PRODUCTS.filter(p =>
        (p.fullName + " " + p.subtitle + " " + p.collection + " " + p.fabric.blend)
          .toLowerCase()
          .includes(q.toLowerCase())
      ).slice(0, 5);

  const trending = ["Saanjh kurta set", "Mulmul 120 GSM", "Sage co-ord", "Festive dobby", "Pickup from Surat"];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: "0",
          background: "rgba(44,40,38,0.35)",
          backdropFilter: "blur(4px)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 240ms cubic-bezier(0.22,1,0.36,1)",
          zIndex: 90,
        }}
      />

      {/* Slide-down panel anchored to header bottom */}
      <div style={{
        position: "fixed",
        left: 0, right: 0,
        top: 0,
        zIndex: 95,
        pointerEvents: open ? "auto" : "none",
      }}>
        <div style={{
          background: "var(--cream)",
          borderBottom: "1px solid var(--hairline)",
          transform: open ? "translateY(0)" : "translateY(-100%)",
          transition: "transform 360ms cubic-bezier(0.22, 1, 0.36, 1)",
          paddingTop: "clamp(76px, 9vw, 100px)",
          paddingBottom: "clamp(32px, 5vw, 56px)",
          boxShadow: open ? "0 24px 48px -28px rgba(44,40,38,0.18)" : "none",
        }}>
          <div className="container">
            {/* Input row */}
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              borderBottom: "1px solid var(--charcoal)",
              paddingBottom: 12,
            }}>
              <span style={{ color: "var(--charcoal)" }}>{Icon.search}</span>
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by piece, fabric, color, GSM…"
                style={{
                  flex: 1,
                  fontFamily: "var(--font-serif)",
                  fontSize: "clamp(20px, 3.4vw, 32px)",
                  fontWeight: 400,
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  color: "var(--charcoal)",
                  letterSpacing: "-0.012em",
                }}
              />
              <button
                onClick={onClose}
                aria-label="Close search"
                style={{
                  fontSize: 11,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "var(--warm-grey)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                className="link-u"
              >
                Close <span style={{ fontSize: 14 }}>×</span>
              </button>
            </div>

            {/* Results */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "clamp(24px, 4vw, 56px)", marginTop: "clamp(24px, 4vw, 32px)" }} className="srch-grid">
              {/* Trending */}
              <div>
                <div className="eyebrow" style={{ marginBottom: 14 }}>{q ? "Suggested" : "Trending"}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {trending.map((t) => (
                    <button
                      key={t}
                      onClick={() => setQ(t)}
                      style={{
                        textAlign: "left",
                        fontFamily: "var(--font-serif)",
                        fontSize: 17,
                        color: "var(--charcoal)",
                        padding: "6px 0",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                      className="link-u"
                    >
                      <span style={{ width: 14, height: 1, background: "var(--terracotta)" }} />
                      {t}
                    </button>
                  ))}
                </div>

                <div className="eyebrow" style={{ marginTop: 32, marginBottom: 14 }}>Collections</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {COLLECTIONS.map((c) => (
                    <button
                      key={c.slug}
                      onClick={() => { navigate({ name: "collection", slug: c.slug }); onClose(); }}
                      style={{
                        textAlign: "left",
                        fontSize: 13,
                        color: "var(--warm-grey)",
                        padding: "4px 0",
                        display: "inline-flex",
                        alignItems: "baseline",
                        gap: 10,
                      }}
                      className="link-u"
                    >
                      {c.name} <span className="tnum" style={{ color: "var(--muted)", fontSize: 11 }}>{c.count}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Product matches */}
              <div>
                <div className="eyebrow" style={{ marginBottom: 14 }}>
                  {q ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "Bestsellers"}
                </div>
                {matches.length === 0 ? (
                  <p style={{ fontSize: 14, color: "var(--warm-grey)", fontStyle: "italic", fontFamily: "var(--font-serif)" }}>
                    Nothing matches “{q}” yet. Try “mulmul”, “sage”, or a GSM range.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {matches.map((p, i) => (
                      <button
                        key={p.id}
                        onClick={() => { navigate({ name: "product", slug: p.slug }); onClose(); }}
                        className="srch-result"
                        style={{
                          display: "grid",
                          gridTemplateColumns: "64px 1fr auto",
                          gap: 16,
                          padding: "10px 0",
                          alignItems: "center",
                          textAlign: "left",
                          borderBottom: i < matches.length - 1 ? "1px solid var(--hairline)" : "none",
                          transition: "background 200ms var(--ease), padding-left 320ms cubic-bezier(0.22,1,0.36,1)",
                        }}
                      >
                        <div style={{ width: 64, height: 80 }}>
                          <window.FabricSwatch
                            name={p.name}
                            gsm={p.fabric.gsm}
                            color={p.colors[0].hex}
                            colorName={p.colors[0].name}
                            weave={p.fabric.weaveKey}
                            aspect="auto"
                            size="sm"
                            showMeta={false}
                            withCorners={false}
                          />
                        </div>
                        <div>
                          <div className="serif" style={{ fontSize: 17 }}>{p.fullName}</div>
                          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                            {p.subtitle} · <span className="tnum">{p.fabric.gsm} GSM</span>
                          </div>
                        </div>
                        <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          <span className="serif tnum" style={{ fontSize: 16 }}>{p.currency}{p.price.toLocaleString("en-IN")}</span>
                          <span style={{ fontSize: 11, color: "var(--terracotta)", letterSpacing: "0.06em", textTransform: "uppercase" }}>View →</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .srch-result:hover { padding-left: 8px !important; background: var(--cream-2); }
        @media (max-width: 700px) {
          .srch-grid { grid-template-columns: 1fr !important; gap: 24px !important; }
        }
      `}</style>
    </>
  );
};

window.SearchPanel = SearchPanel;
