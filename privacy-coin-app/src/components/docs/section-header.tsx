import { type ReactNode } from "react";

interface SectionHeaderProps {
  label: string;
  labelColor?: string;
  lineColor?: string;
  title: ReactNode;
  subtitle?: string;
}

/**
 * Reusable section heading with decorative line, uppercase label, title, and optional subtitle.
 */
export function SectionHeader({
  label,
  labelColor = "text-gray/60",
  lineColor = "from-gray/50",
  title,
  subtitle,
}: SectionHeaderProps) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <div className={`h-px w-8 bg-gradient-to-r ${lineColor} to-transparent`} />
        <span className={`text-[11px] font-mono uppercase tracking-[0.2em] ${labelColor}`}>
          {label}
        </span>
      </div>
      <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground mb-3">
        {title}
      </h2>
      {subtitle && (
        <p className="text-gray text-sm max-w-2xl font-light leading-relaxed">
          {subtitle}
        </p>
      )}
    </div>
  );
}
