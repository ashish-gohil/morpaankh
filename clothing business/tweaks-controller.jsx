/* global React */
// Tweaks panel — brand-name, font pairing, accent color

const { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakText, TweakSelect } = window;

const TweaksController = ({ tweaks, setTweak }) => {
  // Apply tweaks to CSS variables
  React.useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--terracotta", tweaks.accent);
    r.setProperty("--font-serif", tweaks.serif);
    r.setProperty("--font-sans", tweaks.sans);
  }, [tweaks]);

  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Brand">
        <TweakText label="Brand name" value={tweaks.brand} onChange={(v) => setTweak("brand", v)} />
      </TweakSection>
      <TweakSection label="Accent color">
        <TweakColor
          label="Terracotta accent"
          value={tweaks.accent}
          onChange={(v) => setTweak("accent", v)}
          options={["#B7472A", "#7A8761", "#8E5A47", "#B08947"]}
        />
      </TweakSection>
      <TweakSection label="Type pairing">
        <TweakSelect
          label="Headlines (serif)"
          value={tweaks.serif}
          onChange={(v) => setTweak("serif", v)}
          options={[
            { value: '"Cormorant Garamond", Georgia, serif', label: "Cormorant Garamond" },
            { value: '"Playfair Display", Georgia, serif', label: "Playfair Display" },
            { value: '"DM Serif Display", Georgia, serif', label: "DM Serif Display" },
            { value: 'Georgia, "Times New Roman", serif', label: "Georgia (system)" },
          ]}
        />
        <TweakSelect
          label="Body (sans)"
          value={tweaks.sans}
          onChange={(v) => setTweak("sans", v)}
          options={[
            { value: '"Inter", system-ui, sans-serif', label: "Inter" },
            { value: '"DM Sans", system-ui, sans-serif', label: "DM Sans" },
            { value: 'system-ui, -apple-system, sans-serif', label: "System UI" },
          ]}
        />
      </TweakSection>
    </TweaksPanel>
  );
};

window.TweaksController = TweaksController;
