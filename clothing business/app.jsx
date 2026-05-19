/* global React, ReactDOM */
// App entry — routing + state + layout

const { useState: useApp, useEffect: useAppEffect } = React;

const TAPI_DEFAULTS = /*EDITMODE-BEGIN*/{
  "brand": "Tapi & Co.",
  "accent": "#B7472A",
  "serif": "\"Cormorant Garamond\", Georgia, serif",
  "sans": "\"Inter\", system-ui, sans-serif"
}/*EDITMODE-END*/;

const App = () => {
  const [route, setRoute] = useApp({ name: "home" });
  const [cart, setCart] = useApp([]);
  const [cartOpen, setCartOpen] = useApp(false);
  const [sizeGuideOpen, setSizeGuideOpen] = useApp(false);
  const [searchOpen, setSearchOpen] = useApp(false);

  const [tweaks, setTweak] = window.useTweaks(TAPI_DEFAULTS);

  // Apply tweaks to CSS variables
  useAppEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--terracotta", tweaks.accent);
    r.setProperty("--font-serif", tweaks.serif);
    r.setProperty("--font-sans", tweaks.sans);
  }, [tweaks]);

  const navigate = (r) => {
    setRoute(r);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const openProduct = (p) => navigate({ name: "product", slug: p.slug });
  const openCart = () => setCartOpen(true);
  const openSizeGuide = () => setSizeGuideOpen(true);

  const addToCart = (item) => {
    setCart((prev) => {
      const ex = prev.find((p) => p.id === item.id && p.size === item.size && p.color === item.color);
      if (ex) {
        return prev.map((p) => p === ex ? { ...p, qty: p.qty + (item.qty || 1) } : p);
      }
      return [...prev, item];
    });
    setCartOpen(true);
  };
  const removeItem = (idx) => setCart((prev) => prev.filter((_, i) => i !== idx));
  const updateQty = (idx, qty) => setCart((prev) => prev.map((it, i) => i === idx ? { ...it, qty } : it));

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);

  let page = null;
  if (route.name === "home") page = <window.HomePage navigate={navigate} openProduct={openProduct} />;
  else if (route.name === "collection") page = <window.CollectionPage slug={route.slug} navigate={navigate} openProduct={openProduct} />;
  else if (route.name === "product") page = <window.PdpPage slug={route.slug} navigate={navigate} addToCart={addToCart} openSizeGuide={openSizeGuide} />;
  else if (route.name === "about") page = <window.AboutPage navigate={navigate} />;

  return (
    <div data-screen-label={`Tapi · ${route.name}${route.slug ? ` · ${route.slug}` : ""}`}>
      <window.Header route={route} navigate={navigate} cartCount={cartCount} openCart={openCart} openSearch={() => setSearchOpen(true)} brandName={tweaks.brand} />
      {page}
      <window.Footer navigate={navigate} brandName={tweaks.brand} />

      <window.SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} navigate={navigate} openProduct={openProduct} />

      <window.CartDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        items={cart}
        removeItem={removeItem}
        updateQty={updateQty}
      />
      <window.SizeGuide open={sizeGuideOpen} onClose={() => setSizeGuideOpen(false)} />

      <window.TweaksController tweaks={tweaks} setTweak={setTweak} />
    </div>
  );
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
