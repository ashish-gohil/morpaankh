/* global React */
// Custom on-brand dropdown — replaces native <select> where we want full visual control.

const { useState: useDdState, useEffect: useDdEffect, useRef: useDdRef } = React;

const Dropdown = ({
  value,
  onChange,
  options,           // [{ value, label }]
  label,             // optional label shown before the value
  align = "right",   // "left" | "right" — popup alignment
  minWidth = 200,
  variant = "underline", // "underline" | "outline"
}) => {
  const [open, setOpen] = useDdState(false);
  const ref = useDdRef(null);

  useDdEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) || options[0];

  const triggerStyle = variant === "outline"
    ? {
        height: 44,
        padding: "0 14px",
        border: "1px solid " + (open ? "var(--charcoal)" : "var(--hairline-2)"),
        background: "var(--ivory)",
        borderRadius: "var(--r-xs)",
      }
    : {
        height: 32,
        padding: "0 2px",
        borderBottom: "1px solid var(--charcoal)",
        background: "transparent",
      };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...triggerStyle,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          fontFamily: "inherit",
          fontSize: 13,
          color: "var(--charcoal)",
          cursor: "pointer",
          minWidth,
          transition: "border-color 160ms",
        }}
      >
        <span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}>
          {label && <span style={{ color: "var(--warm-grey)", fontSize: 12, letterSpacing: "0.04em" }}>{label}</span>}
          <span>{current.label}</span>
        </span>
        <svg
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          style={{ transition: "transform 200ms cubic-bezier(0.22,1,0.36,1)", transform: open ? "rotate(180deg)" : "none" }}
          aria-hidden="true"
        >
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            [align]: 0,
            background: "var(--cream)",
            border: "1px solid var(--charcoal)",
            borderRadius: "var(--r-xs)",
            listStyle: "none",
            padding: 4,
            margin: 0,
            minWidth: Math.max(minWidth, 180),
            boxShadow: "0 14px 32px rgba(44,40,38,0.12), 0 2px 6px rgba(44,40,38,0.06)",
            zIndex: 50,
            animation: "tapi-dd-in 180ms cubic-bezier(0.22,1,0.36,1)",
          }}
        >
          {options.map((o) => {
            const sel = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={sel}>
                <button
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    fontFamily: "inherit",
                    fontSize: 13,
                    background: sel ? "var(--cream-2)" : "transparent",
                    color: "var(--charcoal)",
                    borderRadius: "var(--r-xs)",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 120ms",
                  }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = "var(--cream-2)"; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                >
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: sel ? "var(--font-serif)" : "inherit", fontSize: sel ? 14 : 13 }}>
                      {o.label}
                    </span>
                    {o.hint && (
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{o.hint}</span>
                    )}
                  </span>
                  {sel && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--terracotta)" strokeWidth="1.6" aria-hidden="true">
                      <path d="M2 7l3.5 3.5L12 4" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <style>{`
        @keyframes tapi-dd-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

window.Dropdown = Dropdown;
