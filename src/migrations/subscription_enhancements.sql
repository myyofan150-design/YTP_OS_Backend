-- Add plan tier and usage type to subscriptions
ALTER TABLE subscriptions
  ADD COLUMN plan_tier  ENUM('free','basic','trial','pro','premium') NULL DEFAULT NULL AFTER autopay,
  ADD COLUMN usage_type ENUM('internal','client')                    NULL DEFAULT NULL AFTER plan_tier;
