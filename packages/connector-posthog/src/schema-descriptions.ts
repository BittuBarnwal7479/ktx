const TABLE_DESCRIPTIONS: Record<string, string> = {
  events:
    'PostHog event stream containing all tracked user interactions. Each row represents a single event with properties, timestamp, and user identifier.',
  persons:
    'PostHog persons table containing unique users, identifiers, and user properties for segmentation and cohort analysis.',
  sessions:
    'PostHog sessions table grouping events into user sessions with duration, entry and exit URLs, and device details.',
  groups:
    'PostHog groups table for B2B and team-based analytics. Contains group identifiers and group properties.',
  person_distinct_ids: 'PostHog identity resolution table mapping distinct_ids to person_ids.',
  cohort_people: 'PostHog dynamic cohort membership table.',
  static_cohort_people: 'PostHog static cohort membership table.',
  'system.cohorts': 'PostHog cohort definitions table.',
  'system.feature_flags': 'PostHog feature flag definitions table.',
  'system.experiments': 'PostHog A/B test and experiment definitions table.',
  'system.surveys': 'PostHog survey definitions table.',
  'system.dashboards': 'PostHog dashboard metadata table.',
  'system.insights': 'PostHog saved insight and chart definitions table.',
};

const COLUMN_DESCRIPTIONS: Record<string, string> = {
  'events.uuid': 'Unique identifier for this specific event.',
  'events.event': 'Event name such as $pageview, $autocapture, $identify, or a custom event.',
  'events.distinct_id': 'User identifier that links events to persons.',
  'events.timestamp': 'UTC timestamp when the event occurred.',
  'events.created_at': 'Timestamp when the event was ingested into PostHog.',
  'events.properties': 'JSON object containing event-specific properties.',
  'events.person_id': 'Internal PostHog person UUID.',
  'events.$session_id': 'Session identifier linking this event to sessions.',
  'persons.id': 'Internal PostHog person UUID.',
  'persons.distinct_id': 'Primary user identifier for joins with events.',
  'persons.properties': 'JSON object containing user properties.',
  'persons.created_at': 'Timestamp when this person was first seen in PostHog.',
  'persons.is_identified': 'Whether the person has been explicitly identified.',
  'sessions.session_id': 'Unique session identifier.',
  'sessions.distinct_id': 'User identifier for this session.',
  'sessions.$start_timestamp': 'Timestamp when the session started.',
  'sessions.$end_timestamp': 'Timestamp when the session ended.',
  'sessions.$session_duration': 'Total session duration in seconds.',
  'groups.index': 'Index identifying the configured PostHog group type.',
  'groups.key': 'Unique identifier for this group.',
  'groups.properties': 'JSON object containing group properties.',
  'groups.created_at': 'Timestamp when this group was first seen.',
  'person_distinct_ids.distinct_id': 'Device or browser identifier for a person.',
  'person_distinct_ids.person_id': 'Internal PostHog person UUID mapped to the distinct_id.',
  'cohort_people.person_id': 'Person UUID belonging to the cohort.',
  'cohort_people.cohort_id': 'Cohort identifier.',
  'static_cohort_people.person_id': 'Person UUID belonging to the static cohort.',
  'static_cohort_people.cohort_id': 'Static cohort identifier.',
  'system.cohorts.id': 'Unique cohort identifier.',
  'system.cohorts.name': 'Human-readable cohort name.',
  'system.feature_flags.id': 'Unique feature flag identifier.',
  'system.feature_flags.key': 'Feature flag key used in code.',
  'system.experiments.id': 'Unique experiment identifier.',
  'system.experiments.name': 'Experiment name.',
  'system.surveys.id': 'Unique survey identifier.',
  'system.surveys.name': 'Survey name.',
  'system.dashboards.id': 'Unique dashboard identifier.',
  'system.dashboards.name': 'Dashboard name.',
  'system.insights.id': 'Unique insight identifier.',
  'system.insights.name': 'Insight or chart name.',
};

const PROPERTY_DESCRIPTIONS: Record<string, string> = {
  $browser: 'User browser name.',
  $browser_version: 'User browser version.',
  $os: 'Operating system.',
  $os_version: 'Operating system version.',
  $device: 'Device name.',
  $device_type: 'Device type.',
  $current_url: 'Full URL of the current page.',
  $pathname: 'Path portion of the current URL.',
  $host: 'Hostname of the current page.',
  $referrer: 'Referrer URL.',
  $referring_domain: 'Referrer domain.',
  $utm_source: 'UTM source parameter.',
  $utm_medium: 'UTM medium parameter.',
  $utm_campaign: 'UTM campaign parameter.',
  $utm_content: 'UTM content parameter.',
  $utm_term: 'UTM term parameter.',
  $lib: 'PostHog library name used to capture the event.',
  $lib_version: 'PostHog library version.',
  $insert_id: 'Unique identifier for event deduplication.',
  $active_feature_flags: 'List of active feature flags for this user or event.',
  $feature_flag: 'Feature flag name for flag-related events.',
  $feature_flag_response: 'Feature flag value or variant.',
};

export function getKtxPostHogTableDescription(tableName: string): string | undefined {
  return TABLE_DESCRIPTIONS[tableName];
}

export function getKtxPostHogColumnDescription(tableName: string, columnName: string): string | undefined {
  return COLUMN_DESCRIPTIONS[`${tableName}.${columnName}`];
}

export function getKtxPostHogPropertyDescription(propertyKey: string): string | null {
  return PROPERTY_DESCRIPTIONS[propertyKey] ?? null;
}
