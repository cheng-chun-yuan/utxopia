import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Shield } from "lucide-react-native";
import { Card, CopyButton } from "@/components/ui";
import { Colors } from "@/lib/colors";
import { truncateAddress } from "@/lib/utils";

interface StealthAddressCardProps {
  address: string | null;
  snsName?: string | null;
}

export default function StealthAddressCard({
  address,
  snsName,
}: StealthAddressCardProps) {
  return (
    <Card variant="privacy">
      <View style={styles.header}>
        <Shield size={20} color={Colors.privacy} />
        <Text style={styles.headerLabel}>Your Stealth Address</Text>
      </View>

      {snsName && <Text style={styles.snsName}>{snsName}</Text>}

      <View style={styles.addressRow}>
        <Text style={styles.address}>
          {address ? truncateAddress(address, 10) : "—"}
        </Text>
        {address && <CopyButton text={address} iconSize={16} />}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  headerLabel: {
    color: Colors.privacy,
    fontSize: 14,
    fontWeight: "600",
  },
  snsName: {
    color: Colors.foreground,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 8,
  },
  addressRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  address: {
    color: Colors.grayLight,
    fontSize: 14,
    fontFamily: "monospace",
    flexShrink: 1,
  },
});
