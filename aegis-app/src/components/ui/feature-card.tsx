"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export type FeatureCardColor = "btc" | "privacy" | "sol" | "purple" | "gray";

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  subtext: string;
  href: string;
  color: FeatureCardColor;
  disabled?: boolean;
  badge?: string;
}

const colorConfig: Record<FeatureCardColor, {
  iconBg: string;
  iconBorder: string;
  iconText: string;
  hoverBorder: string;
  hoverBg: string;
  glowShadow: string;
}> = {
  btc: {
    iconBg: "bg-btc/10",
    iconBorder: "border-btc/20",
    iconText: "text-btc",
    hoverBorder: "hover:border-btc/40",
    hoverBg: "hover:bg-btc/5",
    glowShadow: "hover:shadow-[0_0_20px_rgba(247,147,26,0.15)]",
  },
  privacy: {
    iconBg: "bg-privacy/10",
    iconBorder: "border-privacy/20",
    iconText: "text-privacy",
    hoverBorder: "hover:border-privacy/40",
    hoverBg: "hover:bg-privacy/5",
    glowShadow: "hover:shadow-[0_0_20px_rgba(20,241,149,0.15)]",
  },
  sol: {
    iconBg: "bg-sol/10",
    iconBorder: "border-sol/20",
    iconText: "text-sol",
    hoverBorder: "hover:border-sol/40",
    hoverBg: "hover:bg-sol/5",
    glowShadow: "hover:shadow-[0_0_20px_rgba(153,69,255,0.15)]",
  },
  purple: {
    iconBg: "bg-purple/10",
    iconBorder: "border-purple/20",
    iconText: "text-purple",
    hoverBorder: "hover:border-purple/40",
    hoverBg: "hover:bg-purple/5",
    glowShadow: "hover:shadow-[0_0_20px_rgba(255,171,254,0.15)]",
  },
  gray: {
    iconBg: "bg-gray/10",
    iconBorder: "border-gray/20",
    iconText: "text-gray-light",
    hoverBorder: "hover:border-gray/40",
    hoverBg: "hover:bg-gray/5",
    glowShadow: "",
  },
};

export function FeatureCard({ icon, title, description, subtext, href, color, disabled, badge }: FeatureCardProps) {
  const config = colorConfig[color];

  if (disabled) {
    return (
      <div
        className={cn(
          "flex flex-col items-center p-4 sm:p-6 rounded-[16px] relative",
          "bg-card/50 border border-gray/20",
          "cursor-not-allowed select-none"
        )}
      >
        {badge && (
          <span className="absolute top-3 right-3 text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full bg-purple/10 border border-purple/20 text-purple">
            {badge}
          </span>
        )}
        <div
          className={cn(
            "w-10 h-10 sm:w-14 sm:h-14 rounded-[10px] sm:rounded-[12px] flex items-center justify-center mb-3 sm:mb-4",
            "bg-gray/5 border border-gray/15",
          )}
        >
          <div className="w-5 h-5 sm:w-7 sm:h-7 text-gray/40">
            {icon}
          </div>
        </div>
        <h3 className="text-body2 sm:text-body1 text-gray/50 mb-1">{title}</h3>
        <p className="text-caption sm:text-body2 text-gray/30 mb-1 text-center">{description}</p>
        <span className="text-caption text-gray/25">{subtext}</span>
      </div>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col items-center p-4 sm:p-6 rounded-[16px]",
        "bg-card border border-gray/20",
        "transition-all duration-300 cursor-pointer",
        config.hoverBorder,
        config.hoverBg,
        config.glowShadow,
        "group"
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "w-10 h-10 sm:w-14 sm:h-14 rounded-[10px] sm:rounded-[12px] flex items-center justify-center mb-3 sm:mb-4",
          config.iconBg,
          "border",
          config.iconBorder,
          "transition-all duration-300 group-hover:scale-110"
        )}
      >
        <div className={cn("w-5 h-5 sm:w-7 sm:h-7", config.iconText)}>
          {icon}
        </div>
      </div>

      {/* Title */}
      <h3 className="text-body2 sm:text-body1 text-foreground mb-1">{title}</h3>

      {/* Description */}
      <p className={cn("text-caption sm:text-body2 mb-1 transition-colors duration-300 text-center", config.iconText, "opacity-70 group-hover:opacity-100")}>{description}</p>

      {/* Subtext */}
      <span className="text-caption text-gray">{subtext}</span>
    </Link>
  );
}
