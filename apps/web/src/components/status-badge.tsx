import type { VariantProps } from "class-variance-authority";
import { Badge, type badgeVariants } from "@/components/ui/badge";

type ChipVariant = VariantProps<typeof badgeVariants>["variant"];

export function statusVariant(status: string): ChipVariant {
  if (["COMPLETED", "DONE", "ACCEPTED", "SUCCEEDED"].includes(status)) return "live";
  if (["FAILED", "CANCELLED", "REJECTED"].includes(status)) return "fail";
  if (["CREATED", "SUPERSEDED"].includes(status)) return "secondary";
  return "run"; // any active phase
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariant(status)}>{status}</Badge>;
}
