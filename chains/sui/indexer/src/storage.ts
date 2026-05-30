import type { NormalizedSuiUtxopiaEvent, SuiEventCursor, SuiIndexerState } from "./types";

export interface SuiIndexerStore {
  getState(packageId: string): Promise<SuiIndexerState | undefined>;
  saveState(state: SuiIndexerState): Promise<void>;
  saveEvents(events: NormalizedSuiUtxopiaEvent[]): Promise<void>;
  getEventsAfter(cursor?: SuiEventCursor): Promise<NormalizedSuiUtxopiaEvent[]>;
}

export class InMemorySuiIndexerStore implements SuiIndexerStore {
  private readonly states = new Map<string, SuiIndexerState>();
  private readonly events: NormalizedSuiUtxopiaEvent[] = [];

  async getState(packageId: string): Promise<SuiIndexerState | undefined> {
    return this.states.get(packageId);
  }

  async saveState(state: SuiIndexerState): Promise<void> {
    this.states.set(state.packageId, state);
  }

  async saveEvents(events: NormalizedSuiUtxopiaEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async getEventsAfter(cursor?: SuiEventCursor): Promise<NormalizedSuiUtxopiaEvent[]> {
    if (!cursor) {
      return [...this.events];
    }

    const index = this.events.findIndex((event) => sameCursor(event.cursor, cursor));
    if (index < 0) {
      return [...this.events];
    }

    return this.events.slice(index + 1);
  }
}

function sameCursor(a: SuiEventCursor, b: SuiEventCursor): boolean {
  return a.transactionDigest === b.transactionDigest && a.eventSequence === b.eventSequence;
}

