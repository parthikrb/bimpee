/** Synthwave sun + scrolling grid. Purely decorative. */
export function Backdrop({ dim = false }: { dim?: boolean }) {
  return (
    <div className="synth-bg" aria-hidden="true" style={{ opacity: dim ? 0.55 : 1 }}>
      <div className="synth-sun" />
      <div className="synth-horizon" />
      <div className="synth-grid" />
    </div>
  );
}
