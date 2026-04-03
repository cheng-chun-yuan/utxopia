import { type ReactNode } from "react";

interface DocsSectionProps {
  id: string;
  children: ReactNode;
  className?: string;
}

export function DocsSection({ id, children, className = "" }: DocsSectionProps) {
  return (
    <section
      id={id}
      style={{ scrollMarginTop: "100px" }}
      className={className}
    >
      {children}
    </section>
  );
}
