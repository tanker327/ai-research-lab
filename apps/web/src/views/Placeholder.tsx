export function Placeholder({
  title,
  phase,
  note,
}: {
  title: string;
  phase: string;
  note: string;
}) {
  return (
    <div className="placeholder">
      <div className="ti">{title}</div>
      <div>
        Arrives with <strong>{phase}</strong> — this panel lights up when that phase's gate passes.
      </div>
      <div className="ph-note">{note}</div>
    </div>
  );
}
