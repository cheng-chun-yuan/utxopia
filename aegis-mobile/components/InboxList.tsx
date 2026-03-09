import React, { useCallback } from "react";
import { View, Text, FlatList, StyleSheet } from "react-native";
import { Inbox } from "lucide-react-native";
import { useAegisStore, type InboxNote } from "@/stores/aegis-store";
import { InboxItem } from "@/components/InboxItem";
import { Colors } from "@/lib/colors";

interface InboxListProps {
  /** If true, show only unspent notes. If false, show all notes. */
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
    // Sort by timestamp descending (newest first)
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
        <Inbox size={56} color={Colors.gray} />
        <Text style={styles.emptyTitle}>No notes yet</Text>
        <Text style={styles.emptySubtitle}>
          {unspentOnly
            ? "Received notes will appear here"
            : "Your transaction history will appear here"}
        </Text>
      </View>
    ),
    [unspentOnly],
  );

  const renderHeader = useCallback(
    () => (
      <Text style={styles.sectionHeader}>
        {unspentOnly ? "Received Notes" : "All Activity"}
      </Text>
    ),
    [unspentOnly],
  );

  return (
    <FlatList
      data={notes}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={renderHeader}
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
  sectionHeader: {
    color: Colors.grayLight,
    fontSize: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 12,
    marginTop: 8,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
  },
  emptyTitle: {
    color: Colors.foreground,
    fontSize: 18,
    fontWeight: "600",
    marginTop: 16,
  },
  emptySubtitle: {
    color: Colors.gray,
    fontSize: 14,
    marginTop: 4,
    textAlign: "center",
  },
});
