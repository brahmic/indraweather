CREATE TABLE delivery_subscriptions_v2 (
  channel text NOT NULL,
  recipient_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  unsubscribed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, recipient_id)
);

INSERT INTO delivery_subscriptions_v2
  (channel, recipient_id, active, subscribed_at, unsubscribed_at, updated_at)
SELECT
  'telegram', chat_id::text, active, subscribed_at, unsubscribed_at, updated_at
FROM subscribers;

CREATE TABLE deliveries_v2 (
  bulletin_id uuid NOT NULL REFERENCES bulletins(id) ON DELETE CASCADE,
  channel text NOT NULL,
  recipient_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  external_message_id text,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bulletin_id, channel, recipient_id),
  FOREIGN KEY (channel, recipient_id)
    REFERENCES delivery_subscriptions_v2(channel, recipient_id)
);

INSERT INTO deliveries_v2
  (bulletin_id, channel, recipient_id, status, attempts,
   external_message_id, last_error, sent_at, updated_at)
SELECT
  bulletin_id, 'telegram', chat_id::text, status, attempts,
  telegram_message_id::text, last_error, sent_at, updated_at
FROM deliveries;

DROP TABLE deliveries;
DROP TABLE subscribers;
ALTER TABLE delivery_subscriptions_v2 RENAME TO delivery_subscriptions;
ALTER TABLE deliveries_v2 RENAME TO deliveries;
