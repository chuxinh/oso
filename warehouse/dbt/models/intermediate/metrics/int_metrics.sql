select
  {{ oso_id('"OSO"', '"oso"', 'metric') }} as metric_id,
  "OSO" as metric_source,
  "oso" as metric_namespace,
  metrics.metric as metric_name,
  "TODO" as display_name,
  "TODO" as description,
  null as raw_definition,
  "TODO" as definition_ref,
  "UNKNOWN" as aggregation_function
from {{ ref('int_timeseries_code_metrics_by_artifact__developers') }} as metrics
