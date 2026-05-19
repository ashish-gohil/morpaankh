/* global React */
// Motion primitives: scroll reveals, count-up, staggered animations, magnetic hover.

const { useState: useMState, useEffect: useMEffect, useRef: useMRef } = React;

// -------- useReveal --------
// IntersectionObserver hook — returns ref + boolean "inView"
const useReveal = (opts = {}) => {
  const ref = useMRef(null);
  const [inView, setInView] = useMState(false);
  useMEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inView) return; // one-shot
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: opts.threshold ?? 0.15, rootMargin: opts.rootMargin ?? "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
};

// -------- <Reveal> --------
// Wraps children, fades + translates up when scrolled into view.
const Reveal = ({
  children,
  delay = 0,
  duration = 720,
  y = 24,
  as: As = "div",
  style,
  className,
  threshold,
  once = true,
  ...rest
}) => {
  const [ref, inView] = useReveal({ threshold });
  return (
    <As
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: inView ? 1 : 0,
        transform: inView ? "translate3d(0,0,0)" : `translate3d(0, ${y}px, 0)`,
        transition: `opacity ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
        willChange: "opacity, transform",
      }}
      {...rest}
    >
      {children}
    </As>
  );
};

// -------- <Stagger> --------
// Wraps a list of children — each child reveals with a small delay offset.
const Stagger = ({ children, step = 80, base = 0, ...props }) => {
  const arr = React.Children.toArray(children);
  return (
    <>
      {arr.map((child, i) => (
        <Reveal key={i} delay={base + i * step} {...props}>{child}</Reveal>
      ))}
    </>
  );
};

// -------- <CountUp> --------
// Animates a number from 0 to value when scrolled into view.
// Supports leading/trailing strings (e.g. "11", "120–180", "₹2,499").
const CountUp = ({ value, duration = 1400, suffix = "", style }) => {
  const [ref, inView] = useReveal({ threshold: 0.4 });
  const [n, setN] = useMState(0);
  const v = parseInt(String(value).replace(/[^\d]/g, ""), 10) || 0;
  const prefix = String(value).match(/^[^\d]*/)[0] || "";
  const tail = String(value).match(/[^\d]*$/)[0] || "";

  useMEffect(() => {
    if (!inView) return;
    let raf;
    const start = performance.now();
    const tick = (t) => {
      const elapsed = Math.min(1, (t - start) / duration);
      // Ease out cubic for soft landing
      const eased = 1 - Math.pow(1 - elapsed, 3);
      setN(Math.round(v * eased));
      if (elapsed < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, v, duration]);

  // Render — preserve original non-digit pattern (e.g. "120–180" shows "120–180" once done)
  const display = inView && n >= v ? value : prefix + n.toLocaleString("en-IN") + tail;
  return (
    <span ref={ref} style={style} className="tnum">
      {display}{suffix}
    </span>
  );
};

// -------- <Magnetic> --------
// CTA / icon that subtly tracks the cursor on hover (modern e-commerce flourish).
const Magnetic = ({ children, strength = 0.18, style, className, ...rest }) => {
  const ref = useMRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - (r.left + r.width / 2)) * strength;
    const y = (e.clientY - (r.top + r.height / 2)) * strength;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = "translate3d(0,0,0)";
  };
  return (
    <span
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ display: "inline-flex", ...style }}
      className={className}
      {...rest}
    >
      <span ref={ref} style={{ transition: "transform 360ms cubic-bezier(0.22, 1, 0.36, 1)", display: "inline-flex" }}>
        {children}
      </span>
    </span>
  );
};

// -------- <RevealText> --------
// Word-by-word reveal for big headlines.
const RevealText = ({ text, delay = 0, step = 60, style, className }) => {
  const [ref, inView] = useReveal({ threshold: 0.2 });
  const words = String(text).split(" ");
  return (
    <span ref={ref} className={className} style={{ display: "inline-block", ...style }}>
      {words.map((w, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            overflow: "hidden",
            verticalAlign: "top",
            marginRight: "0.25em",
          }}
        >
          <span
            style={{
              display: "inline-block",
              opacity: inView ? 1 : 0,
              transform: inView ? "translate3d(0,0,0)" : "translate3d(0, 110%, 0)",
              transition: `opacity 700ms cubic-bezier(0.16, 1, 0.3, 1) ${delay + i * step}ms, transform 700ms cubic-bezier(0.16, 1, 0.3, 1) ${delay + i * step}ms`,
            }}
          >
            {w}
          </span>
        </span>
      ))}
    </span>
  );
};

// -------- <Parallax> --------
// Subtle vertical drift on scroll. Use sparingly — only on visual elements.
const Parallax = ({ children, speed = 0.15, style, className }) => {
  const ref = useMRef(null);
  useMEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf;
    const update = () => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // -1..1 range when section is roughly in view
      const progress = (vh / 2 - (r.top + r.height / 2)) / vh;
      el.style.transform = `translate3d(0, ${progress * 40 * speed}px, 0)`;
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [speed]);
  return (
    <div ref={ref} className={className} style={{ willChange: "transform", transition: "transform 80ms linear", ...style }}>
      {children}
    </div>
  );
};

Object.assign(window, { useReveal, Reveal, Stagger, CountUp, Magnetic, RevealText, Parallax });
