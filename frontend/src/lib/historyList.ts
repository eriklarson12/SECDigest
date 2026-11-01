import { formatSector } from "@/lib/format";
import type {
  AnalysisListResponse,
  AnalysisResponse,
  SectorCount,
} from "@/lib/types";

export const PAGE_SIZE = 20;

/** Everything `/history` loads. One reducer so the flags that move together
 * (rows, error, both loading states) cannot be left half-updated. */
export interface HistoryList {
  analyses: AnalysisResponse[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  sectors: SectorCount[];
  // The description is carried by the rows, so a filter that matches nothing has none.
  // Remembering the last one seen keeps the label whole when a second filter empties the
  // page; it is stored with its code so a different one can never inherit it.
  sicLabel: { code: string; description: string } | null;
  // Same rule for the sector: the office name is read off the rows and remembered with
  // the raw value it came from, never taken from the URL.
  sectorLabel: { raw: string; name: string } | null;
}

export type HistoryAction =
  | { type: "reload" }
  | {
      type: "pageLoaded";
      page: AnalysisListResponse;
      sectors: SectorCount[] | null;
      sic: string | null;
      ownerOrg: string | null;
    }
  | { type: "pageFailed"; message: string }
  | { type: "moreStarted" }
  | { type: "moreLoaded"; analyses: AnalysisResponse[] }
  | { type: "moreFailed"; message: string }
  // A Load more response superseded by a newer page one: only the spinner is released.
  | { type: "moreDropped" };

export const INITIAL_HISTORY: HistoryList = {
  analyses: [],
  total: 0,
  hasMore: false,
  loading: true,
  loadingMore: false,
  error: null,
  sectors: [],
  sicLabel: null,
  sectorLabel: null,
};

export function historyReducer(
  state: HistoryList,
  action: HistoryAction,
): HistoryList {
  switch (action.type) {
    case "reload":
      return { ...state, loading: true, error: null };
    case "pageLoaded": {
      const { page, sectors, sic, ownerOrg } = action;
      const description = page.analyses[0]?.sic_description;
      const office = page.analyses[0]?.owner_org;
      return {
        ...state,
        analyses: page.analyses,
        total: page.total,
        hasMore: page.analyses.length === PAGE_SIZE,
        loading: false,
        error: null,
        sectors: sectors ?? state.sectors,
        sicLabel:
          sic && description ? { code: sic, description } : state.sicLabel,
        sectorLabel:
          ownerOrg && office
            ? { raw: ownerOrg, name: formatSector(office) }
            : state.sectorLabel,
      };
    }
    case "pageFailed":
      return { ...state, loading: false, error: action.message };
    case "moreStarted":
      return { ...state, loadingMore: true, error: null };
    case "moreLoaded":
      return {
        ...state,
        analyses: [...state.analyses, ...action.analyses],
        hasMore: action.analyses.length === PAGE_SIZE,
        loadingMore: false,
      };
    case "moreFailed":
      return { ...state, loadingMore: false, error: action.message };
    case "moreDropped":
      return { ...state, loadingMore: false };
  }
}
