import { cn } from "@/lib/utils";

// Sticky topbar + content grid from the mockup shell.
export function Topbar({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center gap-3.5 border-b bg-card px-7 py-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-serif text-[1.15rem] font-normal">{children}</h2>;
}

export function Content({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4.5 px-7 py-6">{children}</div>;
}
