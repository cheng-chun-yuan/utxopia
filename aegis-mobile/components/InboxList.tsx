import React, { useCallback } from "react";
import { View, Text, FlatList, StyleSheet } from "react-native";
import { Inbox } from "lucide-react-native";
import { useAegisStore, type InboxNote } from "@/stores/aegis-store";
import { InboxItem } from "@/components/InboxItem";
import { Colors } from "@/lib/colors";

interface InboxListProps {
  unspentOnly?: boolean;
}

export function InboxList({ unspentOnly = false }: InboxListProps) {
  const inboxNotes = useAegisStore((s) => s.inboxNotes);
  const refreshInbox = useAegisStore((s) => s.refreshInbox);
  const [refreshing, setRefreshing] = React.useState(false);

  const notes = React.useMemo(() => {
    const filtered = unspentOnly
      ? inboxNotes.filter((n) => !n.spent)
      : [...inboxNotes];
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }, [inboxNotes, unspentOnly]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshInbox();
    } finally {
      setRefreshing(false);
    }
  }, [refreshInbox]);

  const renderItem = useCallback(
    ({ item }: { item: InboxNote }) => (
      <InboxItem
        commitment={item.commitment}
        amount={item.amount}
        timestamp={item.timestamp}
        spent={item.spent}
      />
    ),
    [],
  );

  const keyExtractor = useCallback(
    (item: InboxNote) => item.commitment,
    [],
  );

  const renderEmpty = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        <Inbox size={40} color={Colors.gray} />
        <Text style={styles.emptyTitle}>Nothing here yet</Text>
        <Text style={styles.emptySubtitle}>
          {unspentOnly
            ? "Received notes will appear here"
            : "Your activity will appear here"}
        </Text>
      </View>
    ),
    [unspentOnly],
  );

  return (
    <FlatList
      data={notes}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListEmptyComponent={renderEmpty}
      refreshing={refreshing}
      onRefresh={onRefresh}
      contentContainerStyle={notes.length === 0 ? styles.emptyList : styles.list}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    paddingBottom: 24,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 8,
  },
  emptyTitle: {
    color: Colors.grayLight,
    fontSize: 16,
    fontWeight: "600",
  },
  emptySubtitle: {
    color: Colors.gray,
    fontSize: 13,
    textAlign: "center",
  },
});
