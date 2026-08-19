import type * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-md border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

// The console card header: mono uppercase micro-label (mockup .card .hd).
function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "flex items-center gap-2.5 border-b px-4 py-3 font-mono text-[0.68rem] uppercase tracking-[0.09em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("p-4", className)} {...props} />;
}

export { Card, CardContent, CardHeader };
