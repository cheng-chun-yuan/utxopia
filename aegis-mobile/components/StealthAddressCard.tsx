import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { CopyButton } from "@/components/ui";
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
  if (!address) return null;

  return (
    <View style={styles.row}>
      {snsName ? (
        <Text style={styles.snsName}>{snsName}</Text>
      ) : (
        <Text style={styles.address}>{truncateAddress(address, 10)}</Text>
      )}
      <CopyButton text={address} iconSize={14} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
  },
  snsName: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "500",
  },
  address: {
    color: Colors.gray,
    fontSize: 13,
    fontFamily: "monospace",
  },
});
