{# 
  All events monthly to a collection
#}

SELECT
  e.collection_id,
  TIMESTAMP_TRUNC(e.bucket_day, MONTH) as bucket_month,
  e.event_type,
  SUM(e.amount) AS amount
FROM {{ ref('events_daily_to_collection') }} AS e
GROUP BY 1,2,3