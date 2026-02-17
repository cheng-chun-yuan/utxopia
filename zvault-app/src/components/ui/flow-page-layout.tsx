"use client";

import Link from "next/link";
import { ArrowLeft, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";

export type FlowColor = "btc" | "privacy" | "sol" | "purple" | "gray";

interface Badge {
  icon: React.ReactNode;
  label: string;
  color: FlowColor;
}

interface FlowPageLayoutProps {
  /** Back link URL */
  backHref: string;
  /** Back link label */
  backLabel?: string;
  /** Badges to show in header */
  badges?: Badge[];
  /** Icon for the title section */
  titleIcon?: React.ReactNode;
  /** Title text */
  title: string;
  /** Description text */
  description: string;
  /** Main content */
  children: React.ReactNode;
  /** Widget width */
  width?: number;
  /** Whether to show ZK badge by default */
  showZkBadge?: boolean;
}

const colorConfig: Record<FlowColor, {
  iconBg: string;
  iconBorder: string;
  iconText: string;
  badgeBg: string;
  badgeBorder: string;
  badgeText: string;
}> = {
  btc: {
    iconBg: "bg-btc/10",
    iconBorder: "border-btc/20",
    iconText: "text-btc",
    badgeBg: "bg-btc/10",
    badgeBorder: "border-btc/20",
    badgeText: "text-btc",
  },
  privacy: {
    iconBg: "bg-privacy/10",
    iconBorder: "border-privacy/20",
    iconText: "text-privacy",
    badgeBg: "bg-privacy/10",
    badgeBorder: "border-privacy/20",
    badgeText: "text-privacy",
  },
  sol: {
    iconBg: "bg-sol/10",
    iconBorder: "border-sol/20",
    iconText: "text-sol",
    badgeBg: "bg-sol/10",
    badgeBorder: "border-sol/20",
    badgeText: "text-sol",
  },
  purple: {
    iconBg: "bg-purple/10",
    iconBorder: "border-purple/20",
    iconText: "text-purple",
    badgeBg: "bg-purple/10",
    badgeBorder: "border-purple/20",
    badgeText: "text-purple",
  },
  gray: {
    iconBg: "bg-gray/10",
    iconBorder: "border-gray/20",
    iconText: "text-gray-light",
    badgeBg: "bg-gray/10",
    badgeBorder: "border-gray/20",
    badgeText: "text-gray-light",
  },
};

function HeaderBadge({ icon, label, color }: Badge) {
  const config = colorConfig[color];
  return (
    <div className={cn(
      "flex items-center gap-1.5 px-2 py-1 rounded-full border",
      config.badgeBg,
      config.badgeBorder
    )}>
      <span className={cn("w-3 h-3", config.badgeText)}>{icon}</span>
      <span className={cn("text-caption", config.badgeText)}>{label}</span>
    </div>
  );
}

function Footer() {
  return (
    <div className="flex flex-row justify-between items-center gap-2 mt-4 text-gray px-2 pt-4 border-t border-gray/15">
      <div className="flex flex-row items-center gap-4">
        <a
          href="https://zVault.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-light transition-colors text-caption"
        >
          zVault
        </a>
        <a
          href="https://github.com/cheng-chun-yuan/zVault"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-light transition-colors text-caption"
        >
          GitHub
        </a>
      </div>
      <p className="text-caption">Powered by zVault</p>
    </div>
  );
}

export function FlowPageLayout({
  backHref,
  backLabel = "Back",
  badges = [],
  titleIcon,
  title,
  description,
  children,
  width = 420,
  showZkBadge = true,
}: FlowPageLayoutProps) {
  // Add ZK badge by default if requested
  const allBadges = showZkBadge
    ? [...badges, { icon: <Shield className="w-full h-full" />, label: "ZK", color: "privacy" as FlowColor }]
    : badges;

  // Determine title icon color from first badge
  const titleColor = badges.length > 0 ? badges[0].color : "purple";
  const titleConfig = colorConfig[titleColor];

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div
        className="w-full mb-4 flex items-center justify-between relative z-10"
        style={{ maxWidth: `${width}px` }}
      >
        <Link
          href={backHref}
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {backLabel}
        </Link>
        <div className="flex items-center gap-2">
          {allBadges.map((badge, index) => (
            <HeaderBadge key={index} {...badge} />
          ))}
        </div>
      </div>

      {/* Widget */}
      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-4",
          "max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10"
        )}
        style={{ width: `${width}px` }}
      >
        {/* Title */}
        <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray/15">
          {titleIcon && (
            <div className={cn(
              "p-2 rounded-[10px] border",
              titleConfig.iconBg,
              titleConfig.iconBorder
            )}>
              <span className={cn("w-5 h-5 block", titleConfig.iconText)}>
                {titleIcon}
              </span>
            </div>
          )}
          <div>
            <h1 className="text-heading6 text-foreground">{title}</h1>
            <p className="text-caption text-gray">{description}</p>
          </div>
        </div>

        {/* Content */}
        <ErrorBoundary>
          {children}
        </ErrorBoundary>

        {/* Footer */}
        <Footer />
      </div>
    </main>
  );
}
