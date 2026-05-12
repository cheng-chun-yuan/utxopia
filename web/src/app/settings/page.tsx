"use client";

import { Settings as SettingsIcon } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PreferencesForm } from "@/components/settings/preferences-form";

export default function SettingsPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={560}
      badges={[
        {
          icon: <SettingsIcon className="w-full h-full" />,
          label: "Settings",
          color: "privacy",
        },
      ]}
      titleIcon={<SettingsIcon className="w-full h-full" />}
      title="Preferences"
      description="Account-level preferences. Stored locally."
    >
      <PreferencesForm />
    </FlowPageLayout>
  );
}
