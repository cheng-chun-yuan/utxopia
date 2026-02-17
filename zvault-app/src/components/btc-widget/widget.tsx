"use client";

import React, { useState, memo, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ArrowDownToLine, Send, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { DepositFlow } from "./deposit-flow";
import { PayFlow } from "./pay-flow";
import { BalanceView } from "./balance-view";

type TabValue = "deposit" | "pay" | "activity";

// Tab configuration
const TAB_CONFIG = [
  { title: "Deposit", value: "deposit" as TabValue, Icon: ArrowDownToLine },
  { title: "Pay", value: "pay" as TabValue, Icon: Send },
  { title: "Activity", value: "activity" as TabValue, Icon: Clock },
];

// Shared tab button
const TabButton = memo(function TabButton({
  title,
  Icon,
  isActive,
  onClick,
}: {
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex-1 p-[10px] flex items-center justify-center gap-2",
        "text-sm font-semibold rounded-xl cursor-pointer h-10 transition-colors",
        isActive ? "text-purple bg-purple/10" : "text-gray hover:text-gray-light"
      )}
      onClick={onClick}
    >
      <Icon className="w-4 h-4" />
      {title}
    </button>
  );
});

// Footer
const Footer = memo(function Footer() {
  return (
    <div className="flex justify-between items-center gap-2 mt-4 text-gray px-2 text-xs">
      <div className="flex items-center gap-4">
        <a href="https://zVault.xyz" target="_blank" rel="noopener noreferrer" className="hover:text-gray-light">
          zVault
        </a>
        <a href="https://github.com/cheng-chun-yuan/zVault" target="_blank" rel="noopener noreferrer" className="hover:text-gray-light">
          GitHub
        </a>
      </div>
      <span>Powered by zVault</span>
    </div>
  );
});

// Shared widget content (tabs + flows)
function WidgetContent({ selectedTab, setSelectedTab }: {
  selectedTab: TabValue;
  setSelectedTab: (tab: TabValue) => void;
}) {
  const content = useMemo(() => {
    switch (selectedTab) {
      case "deposit": return <DepositFlow />;
      case "pay": return <PayFlow />;
      case "activity": return <BalanceView />;
    }
  }, [selectedTab]);

  return (
    <>
      <div className="flex gap-1 w-full mb-3">
        {TAB_CONFIG.map((tab) => (
          <TabButton
            key={tab.value}
            title={tab.title}
            Icon={tab.Icon}
            isActive={selectedTab === tab.value}
            onClick={() => setSelectedTab(tab.value)}
          />
        ))}
      </div>
      <ErrorBoundary>{content}</ErrorBoundary>
      <Footer />
    </>
  );
}

// Integrated widget (embedded, no dialog)
export function IntegratedWidget({
  className,
  defaultTab = "deposit",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { defaultTab?: TabValue }) {
  const [selectedTab, setSelectedTab] = useState<TabValue>(defaultTab);

  return (
    <div
      {...props}
      className={cn(
        "bg-card border border-gray/30 p-3 w-[420px] max-w-[calc(100vw-32px)] rounded-2xl max-h-[85vh] overflow-y-auto",
        className
      )}
    >
      <WidgetContent selectedTab={selectedTab} setSelectedTab={setSelectedTab} />
    </div>
  );
}

// Dialog widget
export function zkBTCWidget({ trigger, defaultTab = "deposit" }: {
  trigger?: React.ReactNode;
  defaultTab?: TabValue;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTab, setSelectedTab] = useState<TabValue>(defaultTab);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {trigger || <button className="btn-primary">Open zVault</button>}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className={cn(
          "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          "bg-card border border-gray/30 p-3 w-[420px] max-w-[calc(100vw-32px)] rounded-2xl",
          "max-h-[calc(100vh-32px)] overflow-y-auto"
        )}>
          <div className="flex justify-end mb-2">
            <Dialog.Title hidden>zVault</Dialog.Title>
            <Dialog.Close asChild>
              <button className="rounded-lg p-2 text-gray hover:text-white hover:bg-muted" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>
          <WidgetContent selectedTab={selectedTab} setSelectedTab={setSelectedTab} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default zkBTCWidget;
