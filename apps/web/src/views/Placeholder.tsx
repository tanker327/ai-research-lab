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
    <div className="rounded-md border border-dashed border-input bg-muted px-6 py-9 text-center text-muted-foreground">
      <div className="mb-1.5 font-serif text-[1.05rem] text-secondary-foreground">{title}</div>
      <div>
        Arrives with <strong>{phase}</strong> — this panel lights up when that phase's gate passes.
      </div>
      <div className="mt-2 font-mono text-[0.7rem]">{note}</div>
    </div>
  );
}
