/* global React, Logo */
// Header + Footer

const { useState: useChromeState, useEffect: useChromeEffect } = React;

const TrustMarquee = () => {
  const items = window.TAPI_DATA.TRUST_ITEMS;
  const Track = () => (
    <div className="marquee-track">
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 12, fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--cream)" }}>
          <span style={{ width: 4, height: 4, background: "var(--terracotta-soft)", borderRadius: "50%" }} />
          {it.text}
        </span>
      ))}
    </div>
  );
  return (
    <div style={{ background: "var(--charcoal)", color: "var(--cream)", padding: "10px 0", overflow: "hidden" }}>
      <div className="marquee">
        <Track />
        <Track />
      </div>
    </div>
  );
};

const Icon = {
  search: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" strokeLinecap="round"/></svg>,
  user: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>,
  heart: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 21s-7-4.5-9.3-9.2C1 8.3 3 4.5 6.8 4.5c2 0 3.6 1 5.2 3 1.6-2 3.2-3 5.2-3C21 4.5 23 8.3 21.3 11.8 19 16.5 12 21 12 21Z" strokeLinejoin="round"/></svg>,
  bag: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 7h14l-1.2 12.2c-.1 1-.9 1.8-2 1.8H8.2c-1 0-1.9-.8-2-1.8L5 7Z"/><path d="M9 7V5a3 3 0 0 1 6 0v2" strokeLinecap="round"/></svg>,
  menu: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round"/></svg>,
  close: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6 6l12 12M18 6 6 18" strokeLinecap="round"/></svg>,
  arrowRight: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  arrowLong: <svg width="32" height="10" viewBox="0 0 32 10" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M0 5h30M25 1l5 4-5 4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  whatsapp: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.2-1.8-.9-2-1-.3-.1-.5-.2-.7.2s-.8 1-1 1.2c-.2.2-.4.2-.7 0-.3-.2-1.3-.5-2.5-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.3.4-.6.1-.2 0-.4 0-.6 0-.2-.7-1.7-1-2.3-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1.1 1-1.1 2.5s1.1 3 1.2 3.2c.2.2 2.2 3.4 5.4 4.7 3.2 1.3 3.2.9 3.8.8.6-.1 1.8-.7 2.1-1.5.3-.7.3-1.4.2-1.5 0-.1-.2-.2-.5-.3ZM12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Z"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 7l3.5 3.5L12 4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  truck: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 6h11v10H3zM14 9h4l3 4v3h-7"/><circle cx="6.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>,
  pin: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 22s-7-6-7-12a7 7 0 1 1 14 0c0 6-7 12-7 12Z"/><circle cx="12" cy="10" r="3"/></svg>,
  ruler: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 16 16 3l5 5L8 21z"/><path d="M7 14l2 2M10 11l2 2M13 8l2 2"/></svg>,
};

window.Icon = Icon;

const Header = ({ route, navigate, cartCount, openCart, openSearch, brandName }) => {
  const [scrolled, setScrolled] = useChromeState(false);
  const [mobile, setMobile] = useChromeState(false);
  useChromeEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const NavLink = ({ to, label, slug }) => {
    const active = route.name === to && (!slug || route.slug === slug);
    return (
      <button
        onClick={() => { navigate({ name: to, slug }); setMobile(false); }}
        className="link-u"
        style={{
          fontSize: 13,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: active ? "var(--terracotta)" : "var(--charcoal)",
          fontWeight: 500,
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <header style={{ position: "sticky", top: 0, zIndex: 100, background: "var(--cream)" }}>
      <TrustMarquee />
      <div
        style={{
          borderBottom: scrolled ? "1px solid var(--hairline)" : "1px solid transparent",
          transition: "border-color 240ms",
          background: "var(--cream)",
        }}
      >
        <div className="container" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, height: "clamp(60px, 8vw, 76px)" }}>
          {/* Left — nav on desktop, hamburger on mobile */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0 }}>
            <nav style={{ display: "flex", gap: 28 }} className="hdr-nav">
              <NavLink to="collection" slug="kurta-sets" label="Kurta Sets" />
              <NavLink to="collection" slug="co-ord-sets" label="Co-ord" />
              <NavLink to="collection" slug="festive" label="Festive" />
              <NavLink to="about" label="Our Story" />
            </nav>
            <button className="hdr-menu" onClick={() => setMobile(true)} aria-label="Open menu" style={{ display: "none", padding: 8, marginLeft: -8 }}>
              {Icon.menu}
            </button>
          </div>

          {/* Center — logo */}
          <button onClick={() => navigate({ name: "home" })} aria-label="Home" style={{ flex: "0 0 auto" }}>
            <Logo name={brandName} size={24} />
          </button>

          {/* Right — utility */}
          <div style={{ display: "flex", gap: 6, flex: 1, justifyContent: "flex-end", alignItems: "center" }} className="hdr-util">
            <button aria-label="Search" className="icon-btn" onClick={openSearch}>{Icon.search}</button>
            <button aria-label="Account" className="icon-btn hdr-account">{Icon.user}</button>
            <button aria-label="Wishlist" className="icon-btn hdr-wish">{Icon.heart}</button>
            <button aria-label="Cart" onClick={openCart} className="icon-btn" style={{ position: "relative" }}>
              {Icon.bag}
              {cartCount > 0 && <span className="icon-btn-count">{cartCount}</span>}
            </button>
          </div>
        </div>
      </div>

      {mobile && (
        <div onClick={() => setMobile(false)} style={{ position: "fixed", inset: 0, background: "rgba(44,40,38,0.45)", zIndex: 110 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "84%", maxWidth: 320, background: "var(--cream)", padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Logo name={brandName} size={20} />
              <button onClick={() => setMobile(false)} aria-label="Close">{Icon.close}</button>
            </div>
            <nav style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 12 }}>
              <NavLink to="collection" slug="kurta-sets" label="Kurta Sets" />
              <NavLink to="collection" slug="co-ord-sets" label="Co-ord" />
              <NavLink to="collection" slug="festive" label="Festive" />
              <NavLink to="about" label="Our Story" />
              <NavLink to="about" label="Size Guide" />
              <NavLink to="about" label="Returns" />
              <NavLink to="about" label="Contact" />
            </nav>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 900px) {
          .hdr-nav { display: none !important; }
          .hdr-menu { display: inline-flex !important; padding: 8px; margin-left: -8px; }
          .hdr-account, .hdr-wish { display: none; }
          .hdr-util { gap: 14px !important; }
        }
        @media (max-width: 640px) {
          .marquee-track > span { font-size: 10px !important; gap: 8px !important; }
        }
      `}</style>
    </header>
  );
};

const Footer = ({ navigate, brandName }) => {
  const link = {
    fontSize: 14,
    color: "var(--cream)",
    opacity: 0.72,
    cursor: "pointer",
    display: "inline-block",
    paddingBottom: 6,
    transition: "opacity 240ms var(--ease), padding-left 320ms cubic-bezier(0.22,1,0.36,1)",
  };
  const colTitle = {
    fontSize: 10,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: "var(--terracotta-soft)",
    marginBottom: 20,
    fontWeight: 500,
  };
  // shared link hover style
  const onEnter = (e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.paddingLeft = "6px"; };
  const onLeave = (e) => { e.currentTarget.style.opacity = 0.72; e.currentTarget.style.paddingLeft = "0"; };

  return (
    <footer style={{ background: "var(--charcoal)", color: "var(--cream)", marginTop: "clamp(40px, 8vw, 80px)", overflow: "hidden" }}>
      <div className="container" style={{ paddingTop: "clamp(56px, 9vw, 96px)", paddingBottom: "clamp(20px, 3vw, 28px)" }}>

        {/* --- Newsletter --- */}
        <div className="ftr-news" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "clamp(32px, 6vw, 80px)", paddingBottom: "clamp(48px, 8vw, 80px)", borderBottom: "1px solid rgba(248,244,237,0.10)", alignItems: "end" }}>
          <div>
            <div className="eyebrow" style={{ color: "var(--terracotta-soft)", marginBottom: 16 }}>— Stay in the loop</div>
            <div style={{ color: "var(--cream)", fontFamily: "var(--font-serif)", fontSize: "clamp(32px, 4.4vw, 52px)", lineHeight: 1.04, marginBottom: 12, fontWeight: 500, letterSpacing: "-0.012em" }}>
              Letters from the loom.
            </div>
            <p style={{ color: "var(--cream)", opacity: 0.62, maxWidth: 460, fontSize: 14, lineHeight: 1.65, margin: 0 }}>
              Once a fortnight — new arrivals, the story behind the fabric, and a small thing we made by hand.
            </p>
          </div>
          <form onSubmit={(e) => e.preventDefault()} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ position: "relative", display: "flex", alignItems: "center", borderBottom: "1px solid rgba(248,244,237,0.35)", paddingBottom: 6, transition: "border-color 240ms" }}
                 onFocus={(e) => e.currentTarget.style.borderColor = "var(--cream)"}
                 onBlur={(e) => e.currentTarget.style.borderColor = "rgba(248,244,237,0.35)"}>
              <input type="email" placeholder="your.email@example.com" style={{
                flex: 1, background: "transparent", color: "var(--cream)", border: "none",
                fontFamily: "inherit", fontSize: 16, padding: "8px 0", outline: "none",
              }} />
              <button type="submit" className="tapi-arrow-slide" style={{
                color: "var(--cream)",
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
              }}>
                Subscribe {Icon.arrowRight}
              </button>
            </div>
            <span style={{ fontSize: 11, color: "var(--cream)", opacity: 0.4 }}>No spam. Unsubscribe anytime.</span>
          </form>
        </div>

        {/* --- Compact 3-column link block --- */}
        <div className="ftr-cols" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: "clamp(28px, 4vw, 56px)", padding: "clamp(48px, 7vw, 72px) 0" }}>
          {/* Brand block */}
          <div>
            <Logo name={brandName} size={22} color="var(--cream)" />
            <p style={{ color: "var(--cream)", opacity: 0.55, fontSize: 13, maxWidth: 280, lineHeight: 1.7, marginTop: 20 }}>
              A small family in Surat making mid-premium ethnic wear. Honest fabric, honest fit, honest photography.
            </p>
            <div style={{ display: "flex", gap: 14, marginTop: 24 }}>
              <a aria-label="Instagram" style={link} onMouseEnter={onEnter} onMouseLeave={onLeave}>Instagram</a>
              <span style={{ opacity: 0.25 }}>·</span>
              <a aria-label="WhatsApp" style={link} onMouseEnter={onEnter} onMouseLeave={onLeave}>WhatsApp</a>
            </div>
          </div>

          <div>
            <div style={colTitle}>Shop</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={() => navigate({ name: "collection", slug: "kurta-sets" })}>Kurta Sets</a>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={() => navigate({ name: "collection", slug: "co-ord-sets" })}>Co-ord Sets</a>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={() => navigate({ name: "collection", slug: "festive" })}>Festive Edit</a>
            </div>
          </div>

          <div>
            <div style={colTitle}>Help</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave}>Size guide</a>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave}>Exchange &amp; returns</a>
              <a style={link} onMouseEnter={onEnter} onMouseLeave={onLeave}>FAQ</a>
            </div>
          </div>

          <div>
            <div style={colTitle}>Visit</div>
            <p style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", color: "var(--cream)", opacity: 0.72, fontSize: 15, lineHeight: 1.7, margin: 0 }}>
              Rampura, Surat<br/>
              Gujarat 395003<br/>
              Mon–Sat · 10am–7pm
            </p>
            <a style={{ ...link, marginTop: 12, display: "inline-flex", alignItems: "center", gap: 8 }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
              {Icon.whatsapp} &nbsp;Message us
            </a>
          </div>
        </div>

        {/* --- Wordmark statement --- */}
        <div className="ftr-mark" style={{ paddingTop: "clamp(20px, 3vw, 28px)", paddingBottom: "clamp(20px, 3vw, 32px)", borderTop: "1px solid rgba(248,244,237,0.10)" }}>
          <div style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 500,
            fontSize: "clamp(56px, 18vw, 220px)",
            lineHeight: 0.95,
            letterSpacing: "-0.028em",
            color: "rgba(248,244,237,0.08)",
            textAlign: "center",
            userSelect: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}>
            Tapi <span style={{ fontStyle: "italic", color: "rgba(217,122,95,0.30)" }}>&amp;</span> Co.
          </div>
        </div>

        {/* --- Bottom strip --- */}
        <div style={{ paddingTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, color: "var(--cream)", opacity: 0.45, letterSpacing: "0.04em" }}>
            © 2025 {brandName}. Made in Surat, with care.
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 11, color: "var(--cream)", opacity: 0.45, letterSpacing: "0.04em" }}>
            <a style={{ cursor: "pointer" }}>Privacy</a>
            <a style={{ cursor: "pointer" }}>Terms</a>
            <a style={{ cursor: "pointer" }}>Refunds</a>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .ftr-news { grid-template-columns: 1fr !important; gap: 28px !important; }
          .ftr-cols { grid-template-columns: 1fr 1fr !important; gap: 28px !important; }
        }
        @media (max-width: 540px) {
          .ftr-cols { grid-template-columns: 1fr !important; gap: 28px !important; }
        }
      `}</style>
    </footer>
  );
};

window.Header = Header;
window.Footer = Footer;
