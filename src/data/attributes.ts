import type { HomeAssistant } from "custom-card-helpers";
import { normalizeStateValue } from "./history";
import type { HistoryStates } from "./history";
import type { Statistics, StatisticValue, StatisticsMetaData } from "./statistics";

// Entity IDs and statistic IDs never contain "@", so it safely separates
// the entity ID from the attribute name in internal data keys.
const ATTRIBUTE_KEY_SEPARATOR = "@";

export interface AttributeDataKey {
  entityId: string;
  attribute: string;
}

export interface AttributeBucketing {
  align: (timestamp: number) => number;
  advance: (timestamp: number) => number;
}

export const DEFAULT_ATTRIBUTE_STAT_TYPE = "mean" as const;

export type HistoryWsParams = { type: string } & Record<string, unknown>;

export const getAttributeDataKey = (entityId: string, attribute: string): string =>
  `${entityId}${ATTRIBUTE_KEY_SEPARATOR}${attribute}`;

/**
 * Returns the key used to store the data of a statistic ID, optionally
 * narrowed to one entity attribute.
 */
export const getDataKey = (
  statisticId: string | undefined,
  attribute: string | undefined
): string => {
  const id = statisticId?.trim() ?? "";
  const attr = attribute?.trim();
  if (!id || !attr) {
    return id;
  }
  return getAttributeDataKey(id, attr);
};

export const parseAttributeDataKey = (key: string): AttributeDataKey | undefined => {
  const idx = key.indexOf(ATTRIBUTE_KEY_SEPARATOR);
  if (idx <= 0 || idx === key.length - 1) {
    return undefined;
  }
  return {
    entityId: key.slice(0, idx),
    attribute: key.slice(idx + 1),
  };
};

export const isAttributeDataKey = (key: string): boolean =>
  parseAttributeDataKey(key) !== undefined;

export const splitDataKeys = (
  keys: string[]
): { statisticIds: string[]; attributeKeys: string[] } => {
  const statisticIds: string[] = [];
  const attributeKeys: string[] = [];
  keys.forEach((key) => {
    if (isAttributeDataKey(key)) {
      attributeKeys.push(key);
    } else {
      statisticIds.push(key);
    }
  });
  return { statisticIds, attributeKeys };
};

export const getAttributeEntityIds = (attributeKeys: string[]): string[] =>
  Array.from(
    new Set(
      attributeKeys
        .map((key) => parseAttributeDataKey(key)?.entityId)
        .filter((id): id is string => !!id)
    )
  );

export const fetchAttributeHistoryStates = (
  hass: HomeAssistant,
  startTime: Date,
  endTime: Date | undefined,
  entityIds: string[]
) => {
  // Attribute-only updates are dropped by significant_changes_only and
  // minimal_response, so both must be disabled to get every attribute value.
  const payload: HistoryWsParams = {
    type: "history/history_during_period",
    start_time: startTime.toISOString(),
    entity_ids: entityIds,
    minimal_response: false,
    no_attributes: false,
    significant_changes_only: false,
  };
  if (endTime) {
    payload.end_time = endTime.toISOString();
  }
  return hass.callWS<HistoryStates>(payload);
};

export const buildAttributeStreamParams = (
  entityIds: string[],
  startTime: Date
): HistoryWsParams => ({
  type: "history/stream",
  entity_ids: entityIds,
  start_time: startTime.toISOString(),
  minimal_response: false,
  no_attributes: false,
  significant_changes_only: false,
});

export const normalizeAttributeValue = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    return normalizeStateValue(value);
  }
  return null;
};

const extractAttributeTimeline = (
  history: HistoryStates,
  entityId: string,
  attribute: string
): Array<{ timestamp: number; value: number | null }> => {
  const states = history[entityId];
  if (!Array.isArray(states) || !states.length) {
    return [];
  }
  // Attribute changes only move last_updated, so order by it instead of last_changed.
  return states
    .map((entry) => ({
      timestamp: Math.round((entry.lu ?? entry.lc ?? 0) * 1000),
      value: normalizeAttributeValue(entry.a?.[attribute]),
    }))
    .filter((entry) => entry.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
};

const toRawStatistics = (
  timeline: Array<{ timestamp: number; value: number | null }>
): StatisticValue[] => {
  const values: StatisticValue[] = [];
  let previous: number | null | undefined;
  timeline.forEach(({ timestamp, value }) => {
    // Other attributes or the state may update without touching this one.
    if (values.length && value === previous) {
      return;
    }
    previous = value;
    values.push({
      start: timestamp,
      end: timestamp,
      change: value,
      sum: value,
      mean: value,
      min: value,
      max: value,
      state: value,
    });
  });
  return values;
};

const toBucketStatistics = (
  timeline: Array<{ timestamp: number; value: number | null }>,
  rangeStart: number,
  rangeEnd: number | null,
  bucketing: AttributeBucketing
): StatisticValue[] => {
  if (!timeline.length) {
    return [];
  }
  const now = Date.now();
  const effectiveEnd = rangeEnd === null ? now : Math.min(rangeEnd, now);
  const values: StatisticValue[] = [];

  let pointer = 0;
  let bucketStart = bucketing.align(rangeStart);
  let active: number | null = null;
  while (pointer < timeline.length && timeline[pointer].timestamp <= bucketStart) {
    active = timeline[pointer].value;
    pointer++;
  }

  let safety = 0;
  while (bucketStart < effectiveEnd && safety < 200000) {
    safety++;
    const bucketEnd = bucketing.advance(bucketStart);
    if (bucketEnd <= bucketStart) {
      break;
    }
    const segmentEnd = Math.min(bucketEnd, effectiveEnd);
    const startValue: number | null = active;
    let segmentStart = bucketStart;
    let weighted = 0;
    let duration = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let first: number | undefined;
    let last: number | undefined;

    const accumulate = (until: number) => {
      const length = until - segmentStart;
      if (length > 0 && active !== null) {
        weighted += active * length;
        duration += length;
        min = Math.min(min, active);
        max = Math.max(max, active);
        first = first ?? active;
        last = active;
      }
      segmentStart = until;
    };

    while (pointer < timeline.length && timeline[pointer].timestamp < segmentEnd) {
      accumulate(timeline[pointer].timestamp);
      active = timeline[pointer].value;
      pointer++;
    }
    accumulate(segmentEnd);

    if (duration > 0 && first !== undefined && last !== undefined) {
      // Treat the attribute like a meter reading: change is the difference
      // between the value at the end and the value at the start of the bucket.
      const reference = startValue ?? first;
      values.push({
        start: bucketStart,
        end: bucketEnd,
        change: last - reference,
        sum: last,
        mean: weighted / duration,
        min,
        max,
        state: last,
      });
    }

    bucketStart = bucketEnd;
  }

  return values;
};

/**
 * Converts recorder history (fetched with attributes) into statistics keyed by
 * attribute data key. Without bucketing, every attribute change becomes one
 * point, like RAW history. With bucketing, values are aggregated into
 * recorder-like periods (time-weighted mean, min, max, last state/sum and
 * change within the bucket).
 */
export const attributeHistoryToStatistics = (
  history: HistoryStates,
  attributeKeys: string[],
  bucketed?: {
    rangeStart: number;
    rangeEnd: number | null;
    bucketing: AttributeBucketing;
  }
): Statistics => {
  const statistics: Statistics = {};
  attributeKeys.forEach((key) => {
    const parsed = parseAttributeDataKey(key);
    if (!parsed || !(parsed.entityId in history)) {
      return;
    }
    const timeline = extractAttributeTimeline(
      history,
      parsed.entityId,
      parsed.attribute
    );
    statistics[key] = bucketed
      ? toBucketStatistics(
          timeline,
          bucketed.rangeStart,
          bucketed.rangeEnd,
          bucketed.bucketing
        )
      : toRawStatistics(timeline);
  });
  return statistics;
};

export const getAttributeLabel = (
  hass: HomeAssistant,
  entityId: string,
  attribute: string
): string => {
  const stateObj = hass.states?.[entityId];
  const entityName = stateObj?.attributes?.friendly_name ?? entityId;
  const formatter = (hass as unknown as {
    formatEntityAttributeName?: (stateObj: unknown, attribute: string) => string;
  }).formatEntityAttributeName;
  let attributeName = attribute;
  if (stateObj && typeof formatter === "function") {
    try {
      attributeName = formatter(stateObj, attribute) || attribute;
    } catch (_error) {
      attributeName = attribute;
    }
  }
  return `${entityName} ${attributeName}`;
};

export const buildAttributeMetadata = (
  hass: HomeAssistant,
  key: string
): StatisticsMetaData | undefined => {
  const parsed = parseAttributeDataKey(key);
  if (!parsed) {
    return undefined;
  }
  return {
    statistic_id: key,
    statistics_unit_of_measurement: null,
    source: "attribute",
    name: getAttributeLabel(hass, parsed.entityId, parsed.attribute),
    has_sum: false,
    mean_type: 0,
    unit_class: null,
  };
};

export const getNumericAttributeNames = (
  hass: HomeAssistant | undefined,
  entityId: string | undefined
): string[] => {
  const attributes = entityId ? hass?.states?.[entityId]?.attributes : undefined;
  if (!attributes) {
    return [];
  }
  return Object.keys(attributes)
    .filter(
      (name) =>
        name !== "supported_features" &&
        normalizeAttributeValue(attributes[name]) !== null
    )
    .sort();
};
