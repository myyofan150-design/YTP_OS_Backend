-- Add next renewal amount field to subscriptions
ALTER TABLE subscriptions
  ADD COLUMN next_renewal_amount DECIMAL(10,2) NULL DEFAULT NULL AFTER price;
