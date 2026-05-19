/* global React */
// Tapi & Co. — brand logo. Editorial serif wordmark + Tapi-river ripple mark.

const Logo = ({ name = "Tapi & Co.", size = 28, color = "currentColor", showMark = true }) => {
  const [first, rest] = name.includes(" & ") ? name.split(/ & (.+)/) : [name, ""];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        color,
        lineHeight: 1,
        fontFamily: "var(--font-serif)",
        letterSpacing: "0.005em",
      }}
    >
      {showMark && (
        <svg width={size * 1.1} height={size * 1.1} viewBox="0 0 44 44" fill="none" aria-hidden="true">
          <circle cx="22" cy="22" r="21" stroke={color} strokeWidth="1" opacity="0.85" />
          {/* three flowing river-ripple curves */}
          <path d="M9 18 C 14 14, 18 22, 22 18 S 30 14, 35 18" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
          <path d="M9 23 C 14 19, 18 27, 22 23 S 30 19, 35 23" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
          <path d="M9 28 C 14 24, 18 32, 22 28 S 30 24, 35 28" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
        </svg>
      )}
      <span
        style={{
          fontSize: size,
          fontWeight: 500,
          fontStyle: "normal",
          letterSpacing: "-0.01em",
        }}
      >
        {first}
        {rest && (
          <>
            <span style={{ fontStyle: "italic", padding: "0 0.05em", fontWeight: 400 }}> & </span>
            <span>{rest}</span>
          </>
        )}
      </span>
    </span>
  );
};

const LogoStacked = ({ name = "Tapi & Co.", color = "currentColor" }) => {
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 8, color }}>
      <svg width="56" height="56" viewBox="0 0 44 44" fill="none">
        <circle cx="22" cy="22" r="21" stroke={color} strokeWidth="1" />
        <path d="M9 18 C 14 14, 18 22, 22 18 S 30 14, 35 18" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
        <path d="M9 23 C 14 19, 18 27, 22 23 S 30 19, 35 23" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
        <path d="M9 28 C 14 24, 18 32, 22 28 S 30 24, 35 28" stroke={color} strokeWidth="1.1" fill="none" strokeLinecap="round"/>
      </svg>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 500, letterSpacing: "-0.01em" }}>
        {name}
      </div>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: 9, letterSpacing: "0.32em", textTransform: "uppercase", color: "var(--warm-grey)" }}>
        Surat · Est. 2025
      </div>
    </div>
  );
};

window.Logo = Logo;
window.LogoStacked = LogoStacked;
