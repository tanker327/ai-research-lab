import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

// The chip system from the normative mockup (ADR-019): mono, pill, soft
// backgrounds keyed to the console's tier/status palette.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[0.66rem] tracking-[0.05em] [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-input bg-muted text-secondary-foreground",
        outline: "text-foreground",
        live: "border-transparent bg-live-soft text-live",
        run: "border-transparent bg-run-soft text-run",
        frontier: "border-transparent bg-frontier-soft text-frontier",
        fail: "border-transparent bg-fail-soft text-fail",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
